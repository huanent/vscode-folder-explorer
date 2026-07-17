import * as vscode from 'vscode';

export interface ExplorerViewState {
	currentUri: string;
	history: string[];
	view: 'list' | 'grid';
}

export function getWebviewHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	rootUri: vscode.Uri,
	folderName: string,
	initialViewState: ExplorerViewState
): string {
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
<body
	data-root-uri="${escapeHtml(rootUri.toString())}"
	data-current-uri="${escapeHtml(initialViewState.currentUri)}"
	data-history="${escapeHtml(JSON.stringify(initialViewState.history))}"
	data-view="${initialViewState.view}"
>
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
	<section id="archiveProgress" class="archive-progress" role="status" aria-live="polite" hidden>
		<div class="archive-progress-info">
			<div class="archive-progress-heading">
				<span id="archiveProgressLabel">Working...</span>
				<span id="archiveProgressPercent">0%</span>
			</div>
			<div class="archive-progress-track" aria-hidden="true"><div id="archiveProgressBar" class="archive-progress-bar"></div></div>
			<div id="archiveProgressDetail" class="archive-progress-detail"></div>
		</div>
		<button id="cancelArchiveButton" class="archive-cancel-button" type="button">Stop</button>
	</section>
	<div id="contextMenu" class="context-menu" role="menu" hidden>
		<button id="cutButton" type="button" role="menuitem"><i class="codicon codicon-screen-cut"></i><span>Cut</span><span class="menu-shortcut" data-mac="⌘X" data-other="Ctrl+X"></span></button>
		<button id="copyButton" type="button" role="menuitem"><i class="codicon codicon-copy"></i><span>Copy</span><span class="menu-shortcut" data-mac="⌘C" data-other="Ctrl+C"></span></button>
		<button id="pasteButton" type="button" role="menuitem"><i class="codicon codicon-clippy"></i><span>Paste</span><span class="menu-shortcut" data-mac="⌘V" data-other="Ctrl+V"></span></button>
		<div class="context-menu-separator" role="separator"></div>
		<button id="copyPathButton" type="button" role="menuitem"><i class="codicon codicon-copy"></i><span>Copy Path</span><span class="menu-shortcut" data-mac="⌥⌘C" data-other="Shift+Alt+C"></span></button>
		<button id="renameButton" type="button" role="menuitem"><i class="codicon codicon-rename"></i><span>Rename</span><span class="menu-shortcut">F2</span></button>
		<button id="openInNewWindowButton" type="button" role="menuitem"><i class="codicon codicon-empty-window"></i><span>Open in New Window</span></button>
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