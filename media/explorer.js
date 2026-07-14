(function () {
	const vscode = acquireVsCodeApi();
	const elements = {
		backButton: document.getElementById('backButton'),
		upButton: document.getElementById('upButton'),
		refreshButton: document.getElementById('refreshButton'),
		breadcrumbs: document.getElementById('breadcrumbs'),
		listViewButton: document.getElementById('listViewButton'),
		gridViewButton: document.getElementById('gridViewButton'),
		columnHeader: document.getElementById('columnHeader'),
		fileList: document.getElementById('fileList'),
		emptyState: document.getElementById('emptyState'),
		contextMenu: document.getElementById('contextMenu'),
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
		contextEntry: null
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
		elements.upButton.disabled = state.currentUri === state.rootUri;
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
		const size = document.createElement('span');
		size.className = 'entry-size';
		size.textContent = entry.type === 'directory' ? '' : formatSize(entry.size);
		item.append(name, modified, size);

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

	function selectEntry(item) {
		elements.fileList.querySelectorAll('.selected').forEach(element => element.classList.remove('selected'));
		item.classList.add('selected');
		item.focus({ preventScroll: true });
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
		selectEntry(item);
		state.contextEntry = entry;
		elements.contextMenu.hidden = false;
		const width = elements.contextMenu.offsetWidth;
		const height = elements.contextMenu.offsetHeight;
		elements.contextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 8)}px`;
		elements.contextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 8)}px`;
		elements.deleteButton.focus();
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

	function getParentUri(uri) {
		const parent = new URL(uri);
		const parts = decodeURIComponent(parent.pathname).split('/').filter(Boolean);
		parts.pop();
		parent.pathname = `/${parts.join('/')}`;
		return parent.toString();
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
	elements.upButton.addEventListener('click', () => requestDirectory(getParentUri(state.currentUri), true));
	elements.refreshButton.addEventListener('click', () => requestDirectory(state.currentUri, false));
	elements.listViewButton.addEventListener('click', () => setView('list'));
	elements.gridViewButton.addEventListener('click', () => setView('grid'));
	elements.deleteButton.addEventListener('click', () => {
		if (state.contextEntry) {
			vscode.postMessage({ type: 'delete', uri: state.contextEntry.uri });
		}
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
		} else if (message.type === 'deleted') {
			requestDirectory(state.currentUri, false);
		} else if (message.type === 'error') {
			elements.status.textContent = message.message;
			elements.status.hidden = false;
		}
	});

	updateViewButtons();
	vscode.postMessage({ type: 'ready' });
}());