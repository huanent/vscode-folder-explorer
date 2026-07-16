(function () {
	const vscode = acquireVsCodeApi();
	const elements = {
		backButton: document.getElementById('backButton'),
		refreshButton: document.getElementById('refreshButton'),
		breadcrumbs: document.getElementById('breadcrumbs'),
		listViewButton: document.getElementById('listViewButton'),
		gridViewButton: document.getElementById('gridViewButton'),
		columnHeader: document.getElementById('columnHeader'),
		fileListRegion: document.getElementById('fileListRegion'),
		fileList: document.getElementById('fileList'),
		emptyState: document.getElementById('emptyState'),
		contextMenu: document.getElementById('contextMenu'),
		cutButton: document.getElementById('cutButton'),
		copyButton: document.getElementById('copyButton'),
		pasteButton: document.getElementById('pasteButton'),
		copyPathButton: document.getElementById('copyPathButton'),
		renameButton: document.getElementById('renameButton'),
		openInTerminalButton: document.getElementById('openInTerminalButton'),
		compressButton: document.getElementById('compressButton'),
		extractButton: document.getElementById('extractButton'),
		archiveSeparator: document.getElementById('archiveSeparator'),
		deleteButton: document.getElementById('deleteButton'),
		archiveProgress: document.getElementById('archiveProgress'),
		archiveProgressLabel: document.getElementById('archiveProgressLabel'),
		archiveProgressPercent: document.getElementById('archiveProgressPercent'),
		archiveProgressBar: document.getElementById('archiveProgressBar'),
		archiveProgressDetail: document.getElementById('archiveProgressDetail'),
		cancelArchiveButton: document.getElementById('cancelArchiveButton'),
		status: document.getElementById('status')
	};
	const previousState = vscode.getState() || {};
	const rootUri = document.body.dataset.rootUri;
	const initialHistory = JSON.parse(document.body.dataset.history || '[]');
	const state = {
		rootUri,
		currentUri: previousState.rootUri === rootUri && previousState.currentUri
			? previousState.currentUri
			: document.body.dataset.currentUri || rootUri,
		entries: [],
		history: previousState.rootUri === rootUri && Array.isArray(previousState.history)
			? previousState.history
			: initialHistory,
		view: previousState.view === 'grid' || (!previousState.view && document.body.dataset.view === 'grid')
			? 'grid'
			: 'list',
		contextEntry: null,
		selectionAnchorUri: null,
		hasClipboardEntry: false,
		cutUris: new Set(),
		archiveOperation: null
	};

	function startArchiveOperation(kind, message) {
		if (state.archiveOperation) {
			return;
		}
		const operationId = crypto.randomUUID();
		state.archiveOperation = { id: operationId, kind, cancelling: false };
		elements.archiveProgressLabel.textContent = kind === 'compress' ? 'Compressing' : 'Extracting';
		elements.archiveProgressPercent.textContent = '0%';
		elements.archiveProgressBar.style.width = '0%';
		elements.archiveProgressDetail.textContent = 'Starting...';
		elements.cancelArchiveButton.disabled = false;
		elements.cancelArchiveButton.textContent = 'Stop';
		elements.archiveProgress.hidden = false;
		vscode.postMessage({ ...message, type: kind, operationId });
	}

	function finishArchiveOperation(operationId) {
		if (state.archiveOperation?.id !== operationId) {
			return;
		}
		state.archiveOperation = null;
		elements.archiveProgress.hidden = true;
	}

	function requestDirectory(uri, addToHistory) {
		if (addToHistory && uri !== state.currentUri) {
			state.history.push(state.currentUri);
		}
		state.currentUri = uri;
		saveState();
		hideContextMenu();
		elements.status.textContent = 'Loading...';
		elements.status.hidden = false;
		vscode.postMessage({ type: 'readDirectory', uri });
	}

	function openEntry(entry) {
		if (entry.type === 'directory') {
			requestDirectory(entry.uri, true);
			return;
		}
		if (entry.name.toLowerCase().endsWith('.zip')) {
			extractEntry(entry);
			return;
		}
		vscode.postMessage({ type: 'openFile', uri: entry.uri });
	}

	function render() {
		renderBreadcrumbs();
		elements.fileList.replaceChildren(...state.entries.map(createEntryElement));
		elements.fileList.className = `file-list ${state.view}-view`;
		elements.columnHeader.hidden = state.view !== 'list';
		elements.emptyState.hidden = state.entries.length !== 0;
		elements.status.hidden = true;
		elements.backButton.disabled = state.history.length === 0;
		updateViewButtons();
		saveState();
	}

	function saveState() {
		vscode.setState({
			rootUri: state.rootUri,
			currentUri: state.currentUri,
			history: state.history,
			view: state.view
		});
		vscode.postMessage({
			type: 'stateChanged',
			currentUri: state.currentUri,
			history: state.history,
			view: state.view
		});
	}

	function createEntryElement(entry) {
		const item = document.createElement('div');
		item.className = 'file-entry';
		item.setAttribute('role', 'option');
		item.tabIndex = 0;
		item.title = entry.name;
		item.dataset.uri = entry.uri;
		item.classList.toggle('cut', state.cutUris.has(entry.uri));

		const name = document.createElement('div');
		name.className = 'entry-name';
		const icon = document.createElement('i');
		icon.className = `codicon ${entry.type === 'directory' ? 'codicon-folder' : getFileIcon(entry.name)}`;
		const label = document.createElement('span');
		label.textContent = entry.name;
		name.append(icon, label);

		const modified = document.createElement('span');
		modified.className = 'entry-modified';
		modified.textContent = formatDate(entry.modified);
		const created = document.createElement('span');
		created.className = 'entry-created';
		created.textContent = formatDate(entry.created);
		const size = createEntrySizeElement(entry);
		item.append(name, created, modified, size);

		item.addEventListener('click', event => selectEntry(item, event));
		item.addEventListener('dblclick', () => openEntry(entry));
		item.addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				const selectedEntries = getSelectedEntries();
				if (selectedEntries.length === 1) {
					event.preventDefault();
					renameEntry(selectedEntries[0]);
				}
			}
		});
		item.addEventListener('contextmenu', event => showContextMenu(event, entry, item));
		return item;
	}

	function createEntrySizeElement(entry) {
		const size = document.createElement('span');
		size.className = 'entry-size';
		if (entry.type === 'directory') {
			if (entry.calculatedSize !== undefined) {
				const sizeLabel = document.createElement('span');
				sizeLabel.textContent = formatSize(entry.calculatedSize);
				size.append(sizeLabel);
			} else {
				const calculateButton = document.createElement('button');
				calculateButton.type = 'button';
				calculateButton.className = 'calculate-size-button';
				calculateButton.title = entry.calculating
					? 'Calculating folder size'
					: 'Calculate folder size (Command/Ctrl+click calculates all folders)';
				calculateButton.setAttribute('aria-label', calculateButton.title);
				calculateButton.disabled = entry.calculating;
				const calculateIcon = document.createElement('i');
				calculateIcon.className = `codicon ${entry.calculating ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh'}`;
				calculateButton.append(calculateIcon);
				calculateButton.addEventListener('click', event => {
					event.stopPropagation();
					const entries = event.metaKey || event.ctrlKey
						? state.entries.filter(item => item.type === 'directory' && item.calculatedSize === undefined && !item.calculating)
						: [entry];
					entries.forEach(item => {
						item.calculating = true;
						vscode.postMessage({ type: 'calculateDirectorySize', uri: item.uri });
					});
					render();
				});
				calculateButton.addEventListener('dblclick', event => event.stopPropagation());
				size.append(calculateButton);
			}
		} else {
			size.textContent = formatSize(entry.size);
		}
		return size;
	}

	function updateEntrySize(entry) {
		const item = Array.from(elements.fileList.children).find(element => element.dataset.uri === entry.uri);
		const size = item?.querySelector('.entry-size');
		if (size) {
			size.replaceWith(createEntrySizeElement(entry));
		}
	}

	function selectEntry(item, event = {}) {
		const items = Array.from(elements.fileList.querySelectorAll('.file-entry'));
		if (event.shiftKey && state.selectionAnchorUri) {
			const anchorIndex = items.findIndex(element => element.dataset.uri === state.selectionAnchorUri);
			const targetIndex = items.indexOf(item);
			if (anchorIndex >= 0 && targetIndex >= 0) {
				if (!event.metaKey && !event.ctrlKey) {
					items.forEach(element => element.classList.remove('selected'));
				}
				const start = Math.min(anchorIndex, targetIndex);
				const end = Math.max(anchorIndex, targetIndex);
				items.slice(start, end + 1).forEach(element => element.classList.add('selected'));
			}
		} else if (event.metaKey || event.ctrlKey) {
			item.classList.toggle('selected');
			state.selectionAnchorUri = item.dataset.uri;
		} else {
			items.forEach(element => element.classList.remove('selected'));
			item.classList.add('selected');
			state.selectionAnchorUri = item.dataset.uri;
		}
		items.forEach(element => element.setAttribute('aria-selected', String(element.classList.contains('selected'))));
		item.focus({ preventScroll: true });
	}

	function clearSelection() {
		elements.fileList.querySelectorAll('.file-entry.selected').forEach(element => {
			element.classList.remove('selected');
			element.setAttribute('aria-selected', 'false');
		});
		state.selectionAnchorUri = null;
	}

	function selectAllEntries() {
		window.getSelection()?.removeAllRanges();
		const items = Array.from(elements.fileList.querySelectorAll('.file-entry'));
		items.forEach(element => {
			element.classList.add('selected');
			element.setAttribute('aria-selected', 'true');
		});
		state.selectionAnchorUri = items.at(-1)?.dataset.uri || null;
	}

	function getSelectedEntries() {
		const selectedUris = new Set(
			Array.from(elements.fileList.querySelectorAll('.file-entry.selected')).map(element => element.dataset.uri)
		);
		return state.entries.filter(entry => selectedUris.has(entry.uri));
	}

	function renderBreadcrumbs() {
		const root = new URL(state.rootUri);
		const current = new URL(state.currentUri);
		const rootParts = decodeURIComponent(root.pathname).split('/').filter(Boolean);
		const currentParts = decodeURIComponent(current.pathname).split('/').filter(Boolean);
		const relativeParts = currentParts.slice(rootParts.length);
		const parts = [rootParts.at(-1) || decodeURIComponent(root.pathname), ...relativeParts];
		const crumbs = parts.map((part, index) => {
			const button = document.createElement('button');
			button.type = 'button';
			button.textContent = part;
			button.title = part;
			if (index === parts.length - 1) {
				button.setAttribute('aria-current', 'page');
			} else {
				button.addEventListener('click', () => {
					const targetPath = `/${[...rootParts, ...relativeParts.slice(0, index)].join('/')}`;
					const target = new URL(state.rootUri);
					target.pathname = targetPath;
					requestDirectory(target.toString(), true);
				});
			}
			return button;
		});
		const content = [];
		crumbs.forEach((crumb, index) => {
			if (index > 0) {
				const separator = document.createElement('i');
				separator.className = 'codicon codicon-chevron-right breadcrumb-separator';
				content.push(separator);
			}
			content.push(crumb);
		});
		elements.breadcrumbs.replaceChildren(...content);
	}

	function showContextMenu(event, entry, item) {
		event.preventDefault();
		event.stopPropagation();
		if (item) {
			if (!item.classList.contains('selected')) {
				selectEntry(item);
			}
		} else {
			clearSelection();
		}
		state.contextEntry = entry || null;
		const selectedEntries = getSelectedEntries();
		const hasSelection = selectedEntries.length > 0;
		elements.cutButton.disabled = !hasSelection;
		elements.copyButton.disabled = !hasSelection;
		elements.copyPathButton.disabled = !hasSelection;
		elements.renameButton.disabled = selectedEntries.length !== 1;
		elements.openInTerminalButton.hidden = hasSelection && !(
			selectedEntries.length === 1
			&& selectedEntries[0].type === 'directory'
			&& selectedEntries[0].uri === entry?.uri
		);
		const canExtract = selectedEntries.length === 1
			&& selectedEntries[0].type === 'file'
			&& selectedEntries[0].name.toLowerCase().endsWith('.zip');
		elements.compressButton.hidden = !hasSelection || canExtract;
		elements.extractButton.hidden = !canExtract;
		elements.archiveSeparator.hidden = !hasSelection;
		elements.deleteButton.disabled = !hasSelection;
		elements.pasteButton.disabled = !state.hasClipboardEntry;
		elements.contextMenu.hidden = false;
		const width = elements.contextMenu.offsetWidth;
		const height = elements.contextMenu.offsetHeight;
		elements.contextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 8)}px`;
		elements.contextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 8)}px`;
	}

	function hideContextMenu() {
		elements.contextMenu.hidden = true;
		state.contextEntry = null;
	}

	function setView(view) {
		state.view = view;
		render();
	}

	function updateViewButtons() {
		const isList = state.view === 'list';
		elements.listViewButton.classList.toggle('selected', isList);
		elements.gridViewButton.classList.toggle('selected', !isList);
		elements.listViewButton.setAttribute('aria-pressed', String(isList));
		elements.gridViewButton.setAttribute('aria-pressed', String(!isList));
	}

	function cutEntries(entries) {
		if (entries.length > 0) {
			vscode.postMessage({ type: 'setClipboard', operation: 'cut', uris: entries.map(entry => entry.uri) });
		}
	}

	function copyEntries(entries) {
		if (entries.length > 0) {
			vscode.postMessage({ type: 'setClipboard', operation: 'copy', uris: entries.map(entry => entry.uri) });
		}
	}

	function pasteEntry(destinationUri) {
		if (state.hasClipboardEntry) {
			vscode.postMessage({ type: 'paste', destinationUri });
		}
	}

	function renameEntry(entry) {
		if (entry) {
			vscode.postMessage({ type: 'rename', uri: entry.uri });
		}
	}

	function copyPaths(entries) {
		if (entries.length > 0) {
			vscode.postMessage({ type: 'copyPath', uris: entries.map(entry => entry.uri) });
		}
	}

	function openInTerminal(entry) {
		const uri = entry?.type === 'directory' ? entry.uri : state.currentUri;
		vscode.postMessage({ type: 'openInTerminal', uri });
	}

	function compressEntries(entries) {
		if (entries.length > 0) {
			startArchiveOperation('compress', {
				uris: entries.map(entry => entry.uri),
				destinationUri: state.currentUri
			});
		}
	}

	function extractEntry(entry) {
		if (entry?.type === 'file' && entry.name.toLowerCase().endsWith('.zip')) {
			startArchiveOperation('extract', { uri: entry.uri });
		}
	}

	function deleteEntries(entries, permanent = false) {
		if (entries.length > 0) {
			vscode.postMessage({ type: 'delete', uris: entries.map(entry => entry.uri), permanent });
		}
	}

	function getFileIcon(name) {
		const extension = name.split('.').pop().toLowerCase();
		if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(extension)) {
			return 'codicon-file-media';
		}
		if (['zip', 'tar', 'gz', '7z', 'rar'].includes(extension)) {
			return 'codicon-file-zip';
		}
		if (['md', 'mdx'].includes(extension)) {
			return 'codicon-markdown';
		}
		if (['json', 'jsonc'].includes(extension)) {
			return 'codicon-json';
		}
		if (['js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'html', 'py', 'java', 'cs', 'go', 'rs'].includes(extension)) {
			return 'codicon-file-code';
		}
		return 'codicon-file';
	}

	function formatSize(bytes) {
		if (bytes === 0) {
			return '0 B';
		}
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
		const value = bytes / Math.pow(1024, unitIndex);
		return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
	}

	function formatDate(timestamp) {
		return new Intl.DateTimeFormat(undefined, {
			year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
		}).format(timestamp);
	}

	elements.backButton.addEventListener('click', () => {
		const target = state.history.pop();
		if (target) {
			requestDirectory(target, false);
		}
	});
	elements.refreshButton.addEventListener('click', () => requestDirectory(state.currentUri, false));
	elements.listViewButton.addEventListener('click', () => setView('list'));
	elements.gridViewButton.addEventListener('click', () => setView('grid'));
	elements.fileListRegion.addEventListener('click', event => {
		if (!event.target.closest('.file-entry')) {
			clearSelection();
		}
	});
	elements.fileListRegion.addEventListener('contextmenu', event => showContextMenu(event));
	elements.cutButton.addEventListener('click', () => {
		cutEntries(getSelectedEntries());
		hideContextMenu();
	});
	elements.copyButton.addEventListener('click', () => {
		copyEntries(getSelectedEntries());
		hideContextMenu();
	});
	elements.pasteButton.addEventListener('click', () => {
		const destinationUri = state.contextEntry?.type === 'directory'
			? state.contextEntry.uri
			: state.currentUri;
		pasteEntry(destinationUri);
		hideContextMenu();
	});
	elements.copyPathButton.addEventListener('click', () => {
		copyPaths(getSelectedEntries());
		hideContextMenu();
	});
	elements.renameButton.addEventListener('click', () => {
		renameEntry(getSelectedEntries()[0]);
		hideContextMenu();
	});
	elements.openInTerminalButton.addEventListener('click', () => {
		openInTerminal(state.contextEntry);
		hideContextMenu();
	});
	elements.compressButton.addEventListener('click', () => {
		compressEntries(getSelectedEntries());
		hideContextMenu();
	});
	elements.extractButton.addEventListener('click', () => {
		extractEntry(getSelectedEntries()[0]);
		hideContextMenu();
	});
	elements.cancelArchiveButton.addEventListener('click', () => {
		if (!state.archiveOperation || state.archiveOperation.cancelling) {
			return;
		}
		state.archiveOperation.cancelling = true;
		elements.cancelArchiveButton.disabled = true;
		elements.cancelArchiveButton.textContent = 'Stopping...';
		elements.archiveProgressDetail.textContent = 'Stopping operation...';
		vscode.postMessage({ type: 'cancelOperation', operationId: state.archiveOperation.id });
	});
	elements.deleteButton.addEventListener('click', event => {
		deleteEntries(getSelectedEntries(), event.shiftKey);
		hideContextMenu();
	});
	document.addEventListener('click', event => {
		if (!elements.contextMenu.contains(event.target)) {
			hideContextMenu();
		}
	});
	document.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			event.preventDefault();
			hideContextMenu();
			clearSelection();
			return;
		}

		const selectedEntries = getSelectedEntries();
		if ((event.metaKey || event.ctrlKey) && !event.altKey) {
			if (event.key.toLowerCase() === 'a') {
				event.preventDefault();
				selectAllEntries();
			} else if (event.key.toLowerCase() === 'x' && selectedEntries.length > 0) {
				event.preventDefault();
				cutEntries(selectedEntries);
			} else if (event.key.toLowerCase() === 'c' && selectedEntries.length > 0) {
				event.preventDefault();
				copyEntries(selectedEntries);
			} else if (event.key.toLowerCase() === 'v' && state.hasClipboardEntry) {
				event.preventDefault();
				pasteEntry(state.currentUri);
			} else if (event.metaKey && event.key === 'Backspace' && selectedEntries.length > 0) {
				event.preventDefault();
				deleteEntries(selectedEntries, event.shiftKey);
			}
		} else if (event.altKey && event.key.toLowerCase() === 'c' && (event.metaKey || event.shiftKey) && selectedEntries.length > 0) {
			event.preventDefault();
			copyPaths(selectedEntries);
		} else if (event.key === 'F2' && selectedEntries.length === 1) {
			event.preventDefault();
			renameEntry(selectedEntries[0]);
		} else if (event.key === 'Delete' && selectedEntries.length > 0) {
			event.preventDefault();
			deleteEntries(selectedEntries, event.shiftKey);
		}
	});
	window.addEventListener('blur', hideContextMenu);
	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'directory') {
			state.rootUri = message.rootUri;
			state.currentUri = message.currentUri;
			state.entries = message.entries;
			state.selectionAnchorUri = null;
			render();
		} else if (message.type === 'archiveProgress') {
			if (state.archiveOperation?.id === message.operationId && !state.archiveOperation.cancelling) {
				const percent = Math.max(0, Math.min(100, message.percent));
				elements.archiveProgressPercent.textContent = `${Math.round(percent)}%`;
				elements.archiveProgressBar.style.width = `${percent}%`;
				elements.archiveProgressDetail.textContent = message.detail;
			}
		} else if (
			message.type === 'deleted'
			|| message.type === 'pasted'
			|| message.type === 'renamed'
		) {
			requestDirectory(state.currentUri, false);
		} else if (message.type === 'compressed' || message.type === 'extracted') {
			finishArchiveOperation(message.operationId);
			requestDirectory(state.currentUri, false);
		} else if (message.type === 'archiveCancelled' || message.type === 'archiveDismissed') {
			finishArchiveOperation(message.operationId);
		} else if (message.type === 'clipboardChanged') {
			state.hasClipboardEntry = message.hasEntry;
			state.cutUris = new Set(message.operation === 'cut' ? message.uris : []);
			elements.fileList.querySelectorAll('.file-entry').forEach(item => {
				item.classList.toggle('cut', state.cutUris.has(item.dataset.uri));
			});
		} else if (message.type === 'directorySize') {
			const entry = state.entries.find(item => item.uri === message.uri);
			if (entry) {
				entry.calculating = false;
				entry.calculatedSize = message.size;
				updateEntrySize(entry);
			}
		} else if (message.type === 'directorySizeError') {
			const entry = state.entries.find(item => item.uri === message.uri);
			if (entry) {
				entry.calculating = false;
				updateEntrySize(entry);
			}
			elements.status.textContent = message.message;
			elements.status.hidden = false;
		} else if (message.type === 'error') {
			if (message.operationId) {
				finishArchiveOperation(message.operationId);
			}
			elements.status.textContent = message.message;
			elements.status.hidden = false;
		}
	});

	document.querySelectorAll('.menu-shortcut').forEach(element => {
		element.textContent = navigator.platform.toLowerCase().includes('mac')
			? element.dataset.mac
			: element.dataset.other;
	});
	updateViewButtons();
	vscode.postMessage({ type: 'ready', currentUri: state.currentUri });
}());