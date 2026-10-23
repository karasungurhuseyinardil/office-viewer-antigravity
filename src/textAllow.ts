// Files the user chose to edit in the normal text editor ("Edit in editor").
// While their text tab is open they are not switched back to Office Viewer.
export const textEditorAllowed = new Set<string>();

/** 1-based line to scroll to when a file opens in the viewer. */
export const lineOnOpen = new Map<string, number>();
