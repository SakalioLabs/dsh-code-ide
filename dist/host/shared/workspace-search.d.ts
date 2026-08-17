/** Versioned JSON-safe contract shared by the workspace-search Host and browser. */
export type SearchPatternMode = 'literal' | 'regex';
export interface WorkspaceTextSearchQuery {
    pattern: string;
    mode: SearchPatternMode;
    caseSensitive: boolean;
    wholeWord: boolean;
    include?: string[];
    exclude?: string[];
}
export interface FindFilesRequest {
    op: 'findFiles';
    workspaceId: string;
    query: string;
}
export interface FindFileItem {
    path: string;
}
export interface FindFilesResponse {
    items: FindFileItem[];
    incomplete: boolean;
    limit: number;
}
export interface SearchTextRequest {
    op: 'searchText';
    workspaceId: string;
    query: WorkspaceTextSearchQuery;
}
/** Zero-based UTF-16 columns, end-exclusive, in the complete logical line. */
export interface TextSearchRange {
    start: number;
    end: number;
}
export interface TextSearchItem {
    path: string;
    /** One-based logical line number. */
    lineNumber: number;
    /** A UTF-8-budgeted window of the logical line. */
    preview: string;
    /** Zero-based UTF-16 column in the complete line where preview starts. */
    previewStart: number;
    /** Actual line-relative UTF-16 ranges, not preview-relative ranges. */
    ranges: TextSearchRange[];
}
export interface SearchTextResponse {
    items: TextSearchItem[];
    matchCount: number;
    fileCount: number;
    incomplete: boolean;
    limit: number;
}
export interface SearchTextContentOptions {
    maxMatches?: number;
    maxPreviewBytes?: number;
}
/** Validate the deliberately small glob subset shared with the rg adapter. */
export declare function validateSearchGlobs(value: unknown, field: 'include' | 'exclude'): string[];
/** Apply the same validated include/exclude path policy to dirty buffers. */
export declare function matchesSearchPath(path: string, query: WorkspaceTextSearchQuery): boolean;
/**
 * Build a preview containing the first match without cutting a Unicode code
 * point. Undefined means the match itself cannot fit the byte budget.
 */
export declare function textSearchPreview(line: string, first: TextSearchRange, maxBytes?: number): {
    preview: string;
    previewStart: number;
} | undefined;
/** Validate the browser dirty-buffer matcher independently of path filters. */
export declare function validateTextSearchPattern(query: WorkspaceTextSearchQuery): void;
/**
 * Pure matcher for dirty editor buffers. It intentionally works one logical
 * line at a time, matching ripgrep's non-multiline search mode. Invalid regex
 * syntax is reported by the native RegExp SyntaxError to the validating caller.
 */
export declare function searchTextContent(path: string, content: string, query: WorkspaceTextSearchQuery, options?: SearchTextContentOptions): TextSearchItem[];
