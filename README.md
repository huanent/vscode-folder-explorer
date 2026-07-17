# Folder Viewer

Explore and manage a folder in a full-size VS Code editor tab.

Folder Viewer provides a familiar file manager without replacing the built-in Explorer. Open any folder in its own tab, browse with breadcrumbs, switch between list and grid layouts, and perform common file operations without leaving VS Code.

## Features

- Open multiple folders in independent editor tabs
- Browse within the selected root folder using breadcrumbs and back navigation
- Switch between list and grid views
- View file creation time, modification time, and size
- Calculate the size of individual folders or all folders in the current directory
- Open files with their registered VS Code editor
- Cut, copy, paste, rename, and delete files and folders
- Copy one or more absolute paths
- Open a folder in the integrated terminal
- Compress files and folders into ZIP archives
- Extract ZIP archives with progress and cancellation support
- Use multi-selection and familiar keyboard shortcuts

## Getting Started

### From the Explorer

1. Right-click a folder in the built-in VS Code Explorer.
2. Select **Open in Folder Viewer**.

### From the Command Palette

1. Open the Command Palette with `Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows and Linux.
2. Run **Open in Folder Viewer**.
3. Select the folder you want to browse.

Double-click a folder to enter it or a file to open it. Right-click an item or the empty area for file operations and ZIP actions.

## Keyboard Shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Select all | `Cmd+A` | `Ctrl+A` |
| Add to selection | `Cmd+Click` | `Ctrl+Click` |
| Select a range | `Shift+Click` | `Shift+Click` |
| Cut | `Cmd+X` | `Ctrl+X` |
| Copy | `Cmd+C` | `Ctrl+C` |
| Paste | `Cmd+V` | `Ctrl+V` |
| Copy path | `Option+Cmd+C` | `Shift+Alt+C` |
| Rename | `F2` or `Enter` | `F2` or `Enter` |
| Move to trash | `Cmd+Backspace` | `Delete` |
| Delete permanently | `Shift+Cmd+Backspace` | `Shift+Delete` |
| Clear selection | `Escape` | `Escape` |

To calculate every visible folder size, hold `Cmd` on macOS or `Ctrl` on Windows and Linux while clicking a folder's calculate-size button.

## License

[MIT](LICENSE.txt)
