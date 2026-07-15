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
		deleteButton: document.getElementById('deleteButton'),
		status: document.getElementById('status')
	};
	const previousState = vscode.getState() || {};
	const state = {
		rootUri: document.body.dataset.rootUri,
		currentUri: document.body.dataset.rootUri,
		entries: [],
		history: [],
		view: previousState.view === 'grid' ? 'grid' : 'list',
		contextEntry: null,
		hasClipboardEntry: false
	};

	function requestDirectory(uri, addToHistory) {
		if (addToHistory && uri !== state.currentUri) {
			state.history.push(state.currentUri);
		}
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
		vscode.setState({ view: state.view });
	}

	function createEntryElement(entry) {
		const item = document.createElement('div');
		item.className = 'file-entry';
		item.setAttribute('role', 'option');
		item.tabIndex = 0;
		item.title = entry.name;
		item.dataset.uri = entry.uri;

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

		item.addEventListener('click', () => selectEntry(item));
		item.addEventListener('dblclick', () => openEntry(entry));
		item.addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				openEntry(entry);
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

	function selectEntry(item) {
		elements.fileList.querySelectorAll('.selected').forEach(element => element.classList.remove('selected'));
		item.classList.add('selected');
		item.focus({ preventScroll: true });
	}

	function getSelectedEntry() {
		const selectedUri = elements.fileList.querySelector('.file-entry.selected')?.dataset.uri;
		return state.entries.find(entry => entry.uri === selectedUri) || null;
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
			selectEntry(item);
		}
		state.contextEntry = entry || null;
		elements.cutButton.disabled = !entry;
		elements.copyButton.disabled = !entry;
		elements.deleteButton.disabled = !entry;
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

	function cutEntry(entry) {
		if (entry) {
			vscode.postMessage({ type: 'setClipboard', operation: 'cut', uri: entry.uri });
		}
	}

	function copyEntry(entry) {
		if (entry) {
			vscode.postMessage({ type: 'setClipboard', operation: 'copy', uri: entry.uri });
		}
	}

	function pasteEntry(destinationUri) {
		if (state.hasClipboardEntry) {
			vscode.postMessage({ type: 'paste', destinationUri });
		}
	}

	function deleteEntry(entry) {
		if (entry) {
			vscode.postMessage({ type: 'delete', uri: entry.uri });
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
	elements.fileListRegion.addEventListener('contextmenu', event => showContextMenu(event));
	elements.cutButton.addEventListener('click', () => {
		cutEntry(state.contextEntry);
		hideContextMenu();
	});
	elements.copyButton.addEventListener('click', () => {
		copyEntry(state.contextEntry);
		hideContextMenu();
	});
	elements.pasteButton.addEventListener('click', () => {
		const destinationUri = state.contextEntry?.type === 'directory'
			? state.contextEntry.uri
			: state.currentUri;
		pasteEntry(destinationUri);
		hideContextMenu();
	});
	elements.deleteButton.addEventListener('click', () => {
		deleteEntry(state.contextEntry);
		hideContextMenu();
	});
	document.addEventListener('click', event => {
		if (!elements.contextMenu.contains(event.target)) {
			hideContextMenu();
		}
	});
	document.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			hideContextMenu();
			return;
		}

		const selectedEntry = getSelectedEntry();
		if ((event.metaKey || event.ctrlKey) && !event.altKey) {
			if (event.key.toLowerCase() === 'x' && selectedEntry) {
				event.preventDefault();
				cutEntry(selectedEntry);
			} else if (event.key.toLowerCase() === 'c' && selectedEntry) {
				event.preventDefault();
				copyEntry(selectedEntry);
			} else if (event.key.toLowerCase() === 'v' && state.hasClipboardEntry) {
				event.preventDefault();
				pasteEntry(state.currentUri);
			} else if (event.metaKey && event.key === 'Backspace' && selectedEntry) {
				event.preventDefault();
				deleteEntry(selectedEntry);
			}
		} else if (event.key === 'Delete' && selectedEntry) {
			event.preventDefault();
			deleteEntry(selectedEntry);
		}
	});
	window.addEventListener('blur', hideContextMenu);
	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'directory') {
			state.rootUri = message.rootUri;
			state.currentUri = message.currentUri;
			state.entries = message.entries;
			render();
		} else if (message.type === 'deleted' || message.type === 'pasted') {
			requestDirectory(state.currentUri, false);
		} else if (message.type === 'clipboardChanged') {
			state.hasClipboardEntry = message.hasEntry;
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
	vscode.postMessage({ type: 'ready' });
}());