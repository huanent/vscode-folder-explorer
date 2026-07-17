import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { ArchiveOperation, compressEntries, extractArchive, OperationCancelledError } from './archive';
import {
	calculateDirectorySize,
	ClipboardState,
	deleteEntries,
	getDisplayName,
	pasteEntries,
	renameEntry,
	sendDirectory
} from './fileOperations';
import { ExplorerViewState, getWebviewHtml } from './webview';

type WebviewMessage =
	| { type: 'ready'; currentUri?: string }
	| { type: 'stateChanged'; currentUri: string; history: string[]; view: 'list' | 'grid' }
	| { type: 'readDirectory'; uri: string }
	| { type: 'openFile'; uri: string }
	| { type: 'calculateDirectorySize'; uri: string }
	| { type: 'setClipboard'; uris: string[]; operation: 'cut' | 'copy' }
	| { type: 'paste'; destinationUri: string }
	| { type: 'rename'; uri: string }
	| { type: 'copyPath'; uris: string[] }
	| { type: 'openInNewWindow'; uri: string }
	| { type: 'openInTerminal'; uri: string }
	| { type: 'compress'; operationId: string; uris: string[]; destinationUri: string }
	| { type: 'extract'; operationId: string; uri: string }
	| { type: 'cancelOperation'; operationId: string }
	| { type: 'delete'; uris: string[]; permanent: boolean };

class ExplorerDocument implements vscode.CustomDocument {
	latestViewState: ExplorerViewState;

	constructor(readonly uri: vscode.Uri, readonly rootUri: vscode.Uri) {
		this.latestViewState = {
			currentUri: rootUri.toString(),
			history: [],
			view: 'list'
		};
	}

	dispose(): void { }
}

const explorerViewType = 'folderExplorer.editor';

let clipboardState: ClipboardState | undefined;
const explorerPanels = new Set<vscode.WebviewPanel>();

export function activate(context: vscode.ExtensionContext) {
	const editorProvider: vscode.CustomReadonlyEditorProvider<ExplorerDocument> = {
		openCustomDocument: uri => {
			const rootValue = new URLSearchParams(uri.query).get('root');
			if (!rootValue) {
				throw new Error('The folder explorer resource does not contain a root folder.');
			}
			return new ExplorerDocument(uri, vscode.Uri.parse(rootValue));
		},
		resolveCustomEditor: (document, panel) => {
			configureExplorerPanel(context, panel, document);
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('folderExplorer.open', async (uri?: vscode.Uri) => {
			const rootUri = uri ?? (await vscode.window.showOpenDialog({
				defaultUri: vscode.Uri.file(homedir()),
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: 'Open'
			}))?.[0];
			if (rootUri) {
				await openFolderExplorer(rootUri);
			}
		}),
		vscode.window.registerCustomEditorProvider(explorerViewType, editorProvider, {
			supportsMultipleEditorsPerDocument: true,
			webviewOptions: { retainContextWhenHidden: true }
		})
	);
}

export function deactivate() { }

async function openFolderExplorer(rootUri: vscode.Uri): Promise<void> {
	const folderName = getDisplayName(rootUri);
	const resourceUri = vscode.Uri.from({
		scheme: 'folder-explorer',
		path: `/${folderName}.folder-explorer`,
		query: new URLSearchParams({ root: rootUri.toString(), id: randomUUID() }).toString()
	});
	await vscode.commands.executeCommand('vscode.openWith', resourceUri, explorerViewType, {
		preview: false,
		viewColumn: vscode.ViewColumn.Active
	});
}

function configureExplorerPanel(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, document: ExplorerDocument): void {
	const rootUri = document.rootUri;
	const folderName = getDisplayName(rootUri);
	const archiveOperations = new Map<string, ArchiveOperation>();
	panel.title = folderName;
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [
			vscode.Uri.joinPath(context.extensionUri, 'media'),
			vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
		]
	};
	panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'logo.svg');
	explorerPanels.add(panel);
	panel.onDidDispose(() => {
		explorerPanels.delete(panel);
		archiveOperations.forEach(operation => operation.cancelled = true);
	}, undefined, context.subscriptions);
	panel.webview.onDidReceiveMessage(
		async (message: WebviewMessage) => {
			try {
				switch (message.type) {
					case 'cancelOperation': {
						const operation = archiveOperations.get(message.operationId);
						if (operation) {
							operation.cancelled = true;
						}
						break;
					}
					case 'stateChanged':
						document.latestViewState = {
							currentUri: getSafeUri(rootUri, message.currentUri).toString(),
							history: message.history.map(uri => getSafeUri(rootUri, uri).toString()),
							view: message.view
						};
						break;
					case 'ready': {
						const currentUri = message.currentUri ? getSafeUri(rootUri, message.currentUri) : rootUri;
						try {
							await sendDirectory(panel.webview, rootUri, currentUri);
						} catch (error) {
							if (currentUri.toString() === rootUri.toString() || !isFileNotFound(error)) {
								throw error;
							}
							document.latestViewState.currentUri = rootUri.toString();
							document.latestViewState.history = [];
							await sendDirectory(panel.webview, rootUri, rootUri);
						}
						if (clipboardState) {
							await sendClipboardState(panel.webview, clipboardState);
						}
						break;
					}
					case 'readDirectory': {
						const directoryUri = getSafeUri(rootUri, message.uri);
						await sendDirectory(panel.webview, rootUri, directoryUri);
						break;
					}
					case 'openFile': {
						const fileUri = getSafeUri(rootUri, message.uri);
						await vscode.commands.executeCommand('vscode.open', fileUri);
						break;
					}
					case 'calculateDirectorySize': {
						const directoryUri = getSafeUri(rootUri, message.uri);
						try {
							const size = await calculateDirectorySize(directoryUri);
							await panel.webview.postMessage({ type: 'directorySize', uri: message.uri, size });
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error);
							await panel.webview.postMessage({ type: 'directorySizeError', uri: message.uri, message: errorMessage });
						}
						break;
					}
					case 'setClipboard': {
						clipboardState = {
							uris: message.uris.map(uri => getSafeUri(rootUri, uri)),
							operation: message.operation
						};
						await broadcastClipboardState(clipboardState);
						break;
					}
					case 'paste': {
						if (!clipboardState?.uris.length) {
							throw new Error('There is no item to paste.');
						}
						const destinationUri = getSafeUri(rootUri, message.destinationUri);
						const completedUris = await pasteEntries(clipboardState, destinationUri);
						if (clipboardState.operation === 'cut' && completedUris.length > 0) {
							const completed = new Set(completedUris.map(uri => uri.toString()));
							clipboardState.uris = clipboardState.uris.filter(uri => !completed.has(uri.toString()));
							await broadcastClipboardState(clipboardState);
						}
						if (completedUris.length > 0) {
							await panel.webview.postMessage({ type: 'pasted' });
						}
						break;
					}
					case 'rename': {
						const targetUri = getSafeUri(rootUri, message.uri);
						if (await renameEntry(targetUri)) {
							await panel.webview.postMessage({ type: 'renamed' });
						}
						break;
					}
					case 'copyPath': {
						const targetUris = message.uris.map(uri => getSafeUri(rootUri, uri));
						await vscode.env.clipboard.writeText(targetUris.map(uri => uri.fsPath).join('\n'));
						break;
					}
					case 'openInNewWindow': {
						const directoryUri = getSafeUri(rootUri, message.uri);
						const stat = await vscode.workspace.fs.stat(directoryUri);
						if (!(stat.type & vscode.FileType.Directory)) {
							throw new Error('Only folders can be opened in a new window.');
						}
						await vscode.commands.executeCommand('vscode.openFolder', directoryUri, true);
						break;
					}
					case 'openInTerminal': {
						const directoryUri = getSafeUri(rootUri, message.uri);
						const stat = await vscode.workspace.fs.stat(directoryUri);
						if (!(stat.type & vscode.FileType.Directory)) {
							throw new Error('Only folders can be opened in a terminal.');
						}
						const terminal = vscode.window.createTerminal({ cwd: directoryUri, name: getDisplayName(directoryUri) });
						terminal.show();
						break;
					}
					case 'compress': {
						const targetUris = message.uris.map(uri => getSafeUri(rootUri, uri));
						const destinationUri = getSafeUri(rootUri, message.destinationUri);
						const operation = { cancelled: false };
						archiveOperations.set(message.operationId, operation);
						try {
							await compressEntries(targetUris, destinationUri, operation, progress => {
								void panel.webview.postMessage({ type: 'archiveProgress', operationId: message.operationId, ...progress });
							});
							await panel.webview.postMessage({ type: 'compressed', operationId: message.operationId });
						} finally {
							archiveOperations.delete(message.operationId);
						}
						break;
					}
					case 'extract': {
						const archiveUri = getSafeUri(rootUri, message.uri);
						const operation = { cancelled: false };
						archiveOperations.set(message.operationId, operation);
						try {
							if (await extractArchive(archiveUri, operation, progress => {
								void panel.webview.postMessage({ type: 'archiveProgress', operationId: message.operationId, ...progress });
							})) {
								await panel.webview.postMessage({ type: 'extracted', operationId: message.operationId });
							} else {
								await panel.webview.postMessage({ type: 'archiveDismissed', operationId: message.operationId });
							}
						} finally {
							archiveOperations.delete(message.operationId);
						}
						break;
					}
					case 'delete': {
						const targetUris = message.uris.map(uri => getSafeUri(rootUri, uri));
						if (targetUris.some(uri => uri.toString() === rootUri.toString())) {
							throw new Error('The root folder cannot be deleted.');
						}
						await deleteEntries(panel.webview, targetUris, message.permanent);
						break;
					}
				}
			} catch (error) {
				if (error instanceof OperationCancelledError && 'operationId' in message) {
					await panel.webview.postMessage({ type: 'archiveCancelled', operationId: message.operationId });
					return;
				}
				const errorMessage = error instanceof Error ? error.message : String(error);
				await panel.webview.postMessage({
					type: 'error',
					message: errorMessage,
					operationId: 'operationId' in message ? message.operationId : undefined
				});
			}
		},
		undefined,
		context.subscriptions
	);
	panel.webview.html = getWebviewHtml(
		panel.webview,
		context.extensionUri,
		rootUri,
		folderName,
		document.latestViewState
	);
}

async function broadcastClipboardState(state: ClipboardState): Promise<void> {
	await Promise.all([...explorerPanels].map(panel => sendClipboardState(panel.webview, state)));
}

async function sendClipboardState(webview: vscode.Webview, clipboardState: ClipboardState): Promise<void> {
	await webview.postMessage({
		type: 'clipboardChanged',
		hasEntry: clipboardState.uris.length > 0,
		operation: clipboardState.operation,
		uris: clipboardState.uris.map(uri => uri.toString())
	});
}

function isFileNotFound(error: unknown): boolean {
	return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

function getSafeUri(rootUri: vscode.Uri, value: string): vscode.Uri {
	const candidate = vscode.Uri.parse(value);
	const rootPath = rootUri.path.endsWith('/') ? rootUri.path : `${rootUri.path}/`;
	if (
		candidate.scheme !== rootUri.scheme
		|| candidate.authority !== rootUri.authority
		|| (candidate.path !== rootUri.path && !candidate.path.startsWith(rootPath))
	) {
		throw new Error('The requested item is outside the opened folder.');
	}
	return candidate;
}

