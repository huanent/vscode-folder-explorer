import * as vscode from 'vscode';

interface FileEntry {
	name: string;
	uri: string;
	type: 'file' | 'directory';
	size: number;
	modified: number;
}

type WebviewMessage =
	| { type: 'ready' }
	| { type: 'readDirectory'; uri: string }
	| { type: 'openFile'; uri: string }
	| { type: 'delete'; uri: string };

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('fileExplorer.openInEditorArea', (uri: vscode.Uri) => {
			if (uri) {
				openFileExplorer(context, uri);
			}
		})
	);
}

export function deactivate() { }

function openFileExplorer(context: vscode.ExtensionContext, rootUri: vscode.Uri): void {
	const folderName = getDisplayName(rootUri);
	const panel = vscode.window.createWebviewPanel(
		'fileExplorer.editorArea',
		folderName,
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(context.extensionUri, 'media'),
				vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
			]
		}
	);

	panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'logo.png');
	panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, rootUri, folderName);
	panel.webview.onDidReceiveMessage(
		async (message: WebviewMessage) => {
			try {
				switch (message.type) {
					case 'ready':
						await sendDirectory(panel.webview, rootUri, rootUri);
						break;
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
					case 'delete': {
						const targetUri = getSafeUri(rootUri, message.uri);
						if (targetUri.toString() === rootUri.toString()) {
							throw new Error('The root folder cannot be deleted.');
						}
						await deleteEntry(panel.webview, targetUri);
						break;
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await panel.webview.postMessage({ type: 'error', message });
			}
		},
		undefined,
		context.subscriptions
	);
}

async function sendDirectory(webview: vscode.Webview, rootUri: vscode.Uri, directoryUri: vscode.Uri): Promise<void> {
	const directoryEntries = await vscode.workspace.fs.readDirectory(directoryUri);
	const entries = await Promise.all(
		directoryEntries.map(async ([name, fileType]): Promise<FileEntry> => {
			const uri = vscode.Uri.joinPath(directoryUri, name);
			const stat = await vscode.workspace.fs.stat(uri);
			return {
				name,
				uri: uri.toString(),
				type: fileType & vscode.FileType.Directory ? 'directory' : 'file',
				size: stat.size,
				modified: stat.mtime
			};
		})
	);

	entries.sort((left, right) => {
		if (left.type !== right.type) {
			return left.type === 'directory' ? -1 : 1;
		}
		return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
	});

	await webview.postMessage({
		type: 'directory',
		rootUri: rootUri.toString(),
		currentUri: directoryUri.toString(),
		entries
	});
}

async function deleteEntry(webview: vscode.Webview, targetUri: vscode.Uri): Promise<void> {
	const name = getDisplayName(targetUri);
	const choice = await vscode.window.showWarningMessage(
		`Delete "${name}"?`,
		{ modal: true, detail: 'This action moves the item to the Trash when supported by the file system.' },
		'Delete'
	);
	if (choice !== 'Delete') {
		return;
	}

	await vscode.workspace.fs.delete(targetUri, { recursive: true, useTrash: true });
	await webview.postMessage({ type: 'deleted', uri: targetUri.toString() });
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

function getDisplayName(uri: vscode.Uri): string {
	const segments = uri.path.split('/').filter(Boolean);
	return decodeURIComponent(segments.at(-1) ?? uri.path);
}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, rootUri: vscode.Uri, folderName: string): string {
	const nonce = getNonce();
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'explorer.css'));
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'explorer.js'));
	const codiconsUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
	);

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${codiconsUri}">
	<link rel="stylesheet" href="${styleUri}">
	<title>${escapeHtml(folderName)}</title>
</head>
<body data-root-uri="${escapeHtml(rootUri.toString())}">
	<header class="toolbar">
		<div class="navigation-actions" role="toolbar" aria-label="Navigation">
			<button id="backButton" class="icon-button" type="button" title="Back" aria-label="Back" disabled><i class="codicon codicon-arrow-left"></i></button>
			<button id="upButton" class="icon-button" type="button" title="Up one level" aria-label="Up one level" disabled><i class="codicon codicon-arrow-up"></i></button>
			<button id="refreshButton" class="icon-button" type="button" title="Refresh" aria-label="Refresh"><i class="codicon codicon-refresh"></i></button>
		</div>
		<nav id="breadcrumbs" class="breadcrumbs" aria-label="Folder path"></nav>
		<div class="view-actions" role="group" aria-label="View">
			<button id="listViewButton" class="icon-button selected" type="button" title="List view" aria-label="List view" aria-pressed="true"><i class="codicon codicon-list-unordered"></i></button>
			<button id="gridViewButton" class="icon-button" type="button" title="Grid view" aria-label="Grid view" aria-pressed="false"><i class="codicon codicon-layout"></i></button>
		</div>
	</header>
	<main>
		<div id="columnHeader" class="column-header">
			<span>Name</span><span>Modified</span><span>Size</span>
		</div>
		<div id="fileList" class="file-list list-view" role="listbox" aria-label="Folder contents"></div>
		<div id="emptyState" class="empty-state" hidden>This folder is empty.</div>
	</main>
	<div id="contextMenu" class="context-menu" role="menu" hidden>
		<button id="deleteButton" type="button" role="menuitem"><i class="codicon codicon-trash"></i><span>Delete</span></button>
	</div>
	<div id="status" class="status" role="status" aria-live="polite">Loading...</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
}

function getNonce(): string {
	const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let index = 0; index < 32; index++) {
		nonce += characters.charAt(Math.floor(Math.random() * characters.length));
	}
	return nonce;
}
