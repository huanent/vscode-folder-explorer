import { homedir } from 'node:os';
import * as vscode from 'vscode';
import JSZip = require('jszip');

interface FileEntry {
	name: string;
	uri: string;
	type: 'file' | 'directory';
	size: number;
	created: number;
	modified: number;
}

type WebviewMessage =
	| { type: 'ready' }
	| { type: 'readDirectory'; uri: string }
	| { type: 'openFile'; uri: string }
	| { type: 'calculateDirectorySize'; uri: string }
	| { type: 'setClipboard'; uris: string[]; operation: 'cut' | 'copy' }
	| { type: 'paste'; destinationUri: string }
	| { type: 'rename'; uri: string }
	| { type: 'copyPath'; uris: string[] }
	| { type: 'openInTerminal'; uri: string }
	| { type: 'compress'; uris: string[]; destinationUri: string }
	| { type: 'extract'; uri: string }
	| { type: 'delete'; uris: string[] };

interface ClipboardState {
	uris: vscode.Uri[];
	operation: 'cut' | 'copy';
}

export function activate(context: vscode.ExtensionContext) {
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
				openFolderExplorer(context, rootUri);
			}
		})
	);
}

export function deactivate() { }

function openFolderExplorer(context: vscode.ExtensionContext, rootUri: vscode.Uri): void {
	const folderName = getDisplayName(rootUri);
	let clipboardState: ClipboardState | undefined;
	const panel = vscode.window.createWebviewPanel(
		'folderExplorer.editor',
		folderName,
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [
				vscode.Uri.joinPath(context.extensionUri, 'media'),
				vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
			]
		}
	);

	panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'logo.svg');
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
						await sendClipboardState(panel.webview, clipboardState);
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
							await sendClipboardState(panel.webview, clipboardState);
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
						await compressEntries(targetUris, destinationUri);
						await panel.webview.postMessage({ type: 'compressed' });
						break;
					}
					case 'extract': {
						const archiveUri = getSafeUri(rootUri, message.uri);
						if (await extractArchive(archiveUri)) {
							await panel.webview.postMessage({ type: 'extracted' });
						}
						break;
					}
					case 'delete': {
						const targetUris = message.uris.map(uri => getSafeUri(rootUri, uri));
						if (targetUris.some(uri => uri.toString() === rootUri.toString())) {
							throw new Error('The root folder cannot be deleted.');
						}
						await deleteEntries(panel.webview, targetUris);
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

async function sendClipboardState(webview: vscode.Webview, clipboardState: ClipboardState): Promise<void> {
	await webview.postMessage({
		type: 'clipboardChanged',
		hasEntry: clipboardState.uris.length > 0,
		operation: clipboardState.operation,
		uris: clipboardState.uris.map(uri => uri.toString())
	});
}

async function sendDirectory(webview: vscode.Webview, rootUri: vscode.Uri, directoryUri: vscode.Uri): Promise<void> {
	const directoryEntries = (await vscode.workspace.fs.readDirectory(directoryUri))
		.filter(([name]) => name !== '.DS_Store');
	const entries = await Promise.all(
		directoryEntries.map(async ([name, fileType]): Promise<FileEntry> => {
			const uri = vscode.Uri.joinPath(directoryUri, name);
			const stat = await vscode.workspace.fs.stat(uri);
			return {
				name,
				uri: uri.toString(),
				type: fileType & vscode.FileType.Directory ? 'directory' : 'file',
				size: stat.size,
				created: stat.ctime,
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

async function calculateDirectorySize(directoryUri: vscode.Uri): Promise<number> {
	const entries = await vscode.workspace.fs.readDirectory(directoryUri);
	let size = 0;

	for (const [name, fileType] of entries) {
		const uri = vscode.Uri.joinPath(directoryUri, name);
		if (fileType & vscode.FileType.SymbolicLink) {
			continue;
		}
		if (fileType & vscode.FileType.Directory) {
			size += await calculateDirectorySize(uri);
		} else {
			size += (await vscode.workspace.fs.stat(uri)).size;
		}
	}

	return size;
}

async function renameEntry(targetUri: vscode.Uri): Promise<boolean> {
	const currentName = getDisplayName(targetUri);
	const newName = await vscode.window.showInputBox({
		title: 'Rename',
		prompt: 'Enter a new name',
		value: currentName,
		valueSelection: [0, currentName.length],
		validateInput: value => validateEntryName(value)
	});
	if (newName === undefined || newName === currentName) {
		return false;
	}

	const parentUri = vscode.Uri.joinPath(targetUri, '..');
	await vscode.workspace.fs.rename(targetUri, vscode.Uri.joinPath(parentUri, newName), { overwrite: false });
	return true;
}

function validateEntryName(value: string): string | undefined {
	if (!value.trim()) {
		return 'The name cannot be empty.';
	}
	if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
		return 'The name cannot contain path separators.';
	}
	return undefined;
}

async function deleteEntries(webview: vscode.Webview, targetUris: vscode.Uri[]): Promise<void> {
	if (targetUris.length === 0) {
		return;
	}
	const label = targetUris.length === 1 ? `"${getDisplayName(targetUris[0])}"` : `${targetUris.length} items`;
	const choice = await vscode.window.showWarningMessage(
		`Delete ${label}?`,
		{ modal: true, detail: 'This action moves the item to the Trash when supported by the file system.' },
		'Delete'
	);
	if (choice !== 'Delete') {
		return;
	}

	for (const targetUri of targetUris) {
		await vscode.workspace.fs.delete(targetUri, { recursive: true, useTrash: true });
	}
	await webview.postMessage({ type: 'deleted' });
}

async function pasteEntries(clipboardState: ClipboardState, destinationDirectoryUri: vscode.Uri): Promise<vscode.Uri[]> {
	const destinationStat = await vscode.workspace.fs.stat(destinationDirectoryUri);
	if (!(destinationStat.type & vscode.FileType.Directory)) {
		throw new Error('Items can only be pasted into a folder.');
	}
	const completedUris: vscode.Uri[] = [];
	for (const sourceUri of clipboardState.uris) {
		if (await pasteEntry(sourceUri, clipboardState.operation, destinationDirectoryUri)) {
			completedUris.push(sourceUri);
		}
	}
	return completedUris;
}

async function pasteEntry(sourceUri: vscode.Uri, operation: 'cut' | 'copy', destinationDirectoryUri: vscode.Uri): Promise<boolean> {
	const targetUri = vscode.Uri.joinPath(destinationDirectoryUri, getDisplayName(sourceUri));
	if (targetUri.toString() === sourceUri.toString()) {
		await confirmOverwrite(targetUri);
		return false;
	}

	const sourcePath = sourceUri.path.endsWith('/') ? sourceUri.path : `${sourceUri.path}/`;
	if (destinationDirectoryUri.path.startsWith(sourcePath)) {
		throw new Error('A folder cannot be pasted into itself.');
	}

	let overwrite = false;
	try {
		await vscode.workspace.fs.stat(targetUri);
		if (!(await confirmOverwrite(targetUri))) {
			return false;
		}
		overwrite = true;
	} catch (error) {
		if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
			throw error;
		}
	}

	if (operation === 'cut') {
		await vscode.workspace.fs.rename(sourceUri, targetUri, { overwrite });
	} else {
		await vscode.workspace.fs.copy(sourceUri, targetUri, { overwrite });
	}
	return true;
}

async function confirmOverwrite(targetUri: vscode.Uri): Promise<boolean> {
	const choice = await vscode.window.showWarningMessage(
		`Replace "${getDisplayName(targetUri)}"?`,
		{ modal: true, detail: 'An item with the same name already exists in the destination folder.' },
		'Replace'
	);
	return choice === 'Replace';
}

async function compressEntries(sourceUris: vscode.Uri[], destinationDirectoryUri: vscode.Uri): Promise<void> {
	if (sourceUris.length === 0) {
		return;
	}
	const destinationStat = await vscode.workspace.fs.stat(destinationDirectoryUri);
	if (!(destinationStat.type & vscode.FileType.Directory)) {
		throw new Error('Archives can only be created in a folder.');
	}

	const zip = new JSZip();
	const singleStat = sourceUris.length === 1 ? await vscode.workspace.fs.stat(sourceUris[0]) : undefined;
	if (sourceUris.length === 1 && singleStat && singleStat.type & vscode.FileType.Directory) {
		await addDirectoryToZip(zip, sourceUris[0], '');
	} else {
		for (const sourceUri of sourceUris) {
			await addEntryToZip(zip, sourceUri, getDisplayName(sourceUri));
		}
	}

	const defaultName = sourceUris.length === 1 ? `${getDisplayName(sourceUris[0])}.zip` : 'Archive.zip';
	const archiveUri = await getAvailableChildUri(destinationDirectoryUri, defaultName);
	const content = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
	await vscode.workspace.fs.writeFile(archiveUri, content);
}

async function addEntryToZip(zip: JSZip, sourceUri: vscode.Uri, zipPath: string): Promise<void> {
	const stat = await vscode.workspace.fs.stat(sourceUri);
	if (stat.type & vscode.FileType.SymbolicLink) {
		return;
	}
	if (stat.type & vscode.FileType.Directory) {
		zip.folder(zipPath);
		await addDirectoryToZip(zip, sourceUri, zipPath);
		return;
	}
	zip.file(zipPath, await vscode.workspace.fs.readFile(sourceUri), { date: new Date(stat.mtime) });
}

async function addDirectoryToZip(zip: JSZip, directoryUri: vscode.Uri, zipPath: string): Promise<void> {
	const entries = await vscode.workspace.fs.readDirectory(directoryUri);
	for (const [name] of entries) {
		const entryPath = zipPath ? `${zipPath}/${name}` : name;
		await addEntryToZip(zip, vscode.Uri.joinPath(directoryUri, name), entryPath);
	}
}

async function extractArchive(archiveUri: vscode.Uri): Promise<boolean> {
	if (!getDisplayName(archiveUri).toLowerCase().endsWith('.zip')) {
		throw new Error('Only ZIP archives can be extracted.');
	}
	const archiveStat = await vscode.workspace.fs.stat(archiveUri);
	if (!(archiveStat.type & vscode.FileType.File)) {
		throw new Error('Only ZIP files can be extracted.');
	}

	const parentUri = vscode.Uri.joinPath(archiveUri, '..');
	const folderName = getDisplayName(archiveUri).slice(0, -4);
	const destinationUri = vscode.Uri.joinPath(parentUri, folderName);
	try {
		const destinationStat = await vscode.workspace.fs.stat(destinationUri);
		if (!(destinationStat.type & vscode.FileType.Directory)) {
			throw new Error(`Cannot extract because "${folderName}" already exists and is not a folder.`);
		}
		const choice = await vscode.window.showWarningMessage(
			`The folder "${folderName}" already exists. Merge into it?`,
			{ modal: true, detail: 'Existing files with the same names will be replaced.' },
			'Merge'
		);
		if (choice !== 'Merge') {
			return false;
		}
	} catch (error) {
		if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
			throw error;
		}
		await vscode.workspace.fs.createDirectory(destinationUri);
	}

	const zip = await JSZip.loadAsync(await vscode.workspace.fs.readFile(archiveUri));
	for (const [relativePath, entry] of Object.entries(zip.files)) {
		const safeParts = getSafeArchivePathParts(relativePath);
		if (safeParts.length === 0) {
			continue;
		}
		const targetUri = vscode.Uri.joinPath(destinationUri, ...safeParts);
		if (entry.dir) {
			await vscode.workspace.fs.createDirectory(targetUri);
		} else {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(targetUri, '..'));
			await vscode.workspace.fs.writeFile(targetUri, await entry.async('uint8array'));
		}
	}
	return true;
}

function getSafeArchivePathParts(relativePath: string): string[] {
	const normalized = relativePath.replaceAll('\\', '/');
	const parts = normalized.split('/').filter(Boolean);
	if (normalized.startsWith('/') || parts.some(part => part === '.' || part === '..')) {
		throw new Error(`The archive contains an unsafe path: ${relativePath}`);
	}
	return parts;
}

async function getAvailableChildUri(parentUri: vscode.Uri, requestedName: string): Promise<vscode.Uri> {
	const extensionIndex = requestedName.toLowerCase().endsWith('.zip') ? requestedName.length - 4 : requestedName.length;
	const baseName = requestedName.slice(0, extensionIndex);
	const extension = requestedName.slice(extensionIndex);
	let index = 1;
	let candidate = vscode.Uri.joinPath(parentUri, requestedName);
	while (await uriExists(candidate)) {
		index += 1;
		candidate = vscode.Uri.joinPath(parentUri, `${baseName} ${index}${extension}`);
	}
	return candidate;
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch (error) {
		if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
			return false;
		}
		throw error;
	}
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
			<button id="refreshButton" class="icon-button" type="button" title="Refresh" aria-label="Refresh"><i class="codicon codicon-refresh"></i></button>
		</div>
		<nav id="breadcrumbs" class="breadcrumbs" aria-label="Folder path"></nav>
		<div class="view-actions" role="group" aria-label="View">
			<button id="listViewButton" class="icon-button selected" type="button" title="List view" aria-label="List view" aria-pressed="true"><i class="codicon codicon-list-unordered"></i></button>
			<button id="gridViewButton" class="icon-button" type="button" title="Grid view" aria-label="Grid view" aria-pressed="false"><i class="codicon codicon-layout"></i></button>
		</div>
	</header>
	<main id="fileListRegion">
		<div id="columnHeader" class="column-header">
			<span>Name</span><span>Created</span><span>Modified</span><span>Size</span>
		</div>
		<div id="fileList" class="file-list list-view" role="listbox" aria-label="Folder contents" aria-multiselectable="true"></div>
		<div id="emptyState" class="empty-state" hidden>This folder is empty.</div>
	</main>
	<div id="contextMenu" class="context-menu" role="menu" hidden>
		<button id="cutButton" type="button" role="menuitem"><i class="codicon codicon-screen-cut"></i><span>Cut</span><span class="menu-shortcut" data-mac="⌘X" data-other="Ctrl+X"></span></button>
		<button id="copyButton" type="button" role="menuitem"><i class="codicon codicon-copy"></i><span>Copy</span><span class="menu-shortcut" data-mac="⌘C" data-other="Ctrl+C"></span></button>
		<button id="pasteButton" type="button" role="menuitem"><i class="codicon codicon-clippy"></i><span>Paste</span><span class="menu-shortcut" data-mac="⌘V" data-other="Ctrl+V"></span></button>
		<div class="context-menu-separator" role="separator"></div>
		<button id="copyPathButton" type="button" role="menuitem"><i class="codicon codicon-copy"></i><span>Copy Path</span><span class="menu-shortcut" data-mac="⌥⌘C" data-other="Shift+Alt+C"></span></button>
		<button id="renameButton" type="button" role="menuitem"><i class="codicon codicon-rename"></i><span>Rename</span><span class="menu-shortcut">F2</span></button>
		<button id="openInTerminalButton" type="button" role="menuitem"><i class="codicon codicon-terminal"></i><span>Open in Terminal</span></button>
		<div class="context-menu-separator" role="separator"></div>
		<button id="compressButton" type="button" role="menuitem"><i class="codicon codicon-file-zip"></i><span>Compress to ZIP</span></button>
		<button id="extractButton" type="button" role="menuitem"><i class="codicon codicon-file-zip"></i><span>Extract ZIP</span></button>
		<div id="archiveSeparator" class="context-menu-separator" role="separator"></div>
		<button id="deleteButton" type="button" role="menuitem"><i class="codicon codicon-trash"></i><span>Delete</span><span class="menu-shortcut" data-mac="⌘⌫" data-other="Delete"></span></button>
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
