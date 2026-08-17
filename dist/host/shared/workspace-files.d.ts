/** Browser/Host wire budget for a read-only text prefix. */
export declare const READ_ONLY_FILE_PREVIEW_BYTES: number;
/** Maximum configured editable-file budget accepted by the browser decoder. */
export declare const MAX_CLIENT_EDITABLE_FILE_BYTES: number;
export interface ReadOnlyFilePresentation {
    readonly reason: 'binary' | 'too-large';
    /** Exact byte size of the versioned file snapshot. */
    readonly sizeBytes: number;
    /** Host-configured maximum size of an editable text file. */
    readonly limitBytes: number;
    /** UTF-8 bytes represented by `content`; zero for binary placeholders. */
    readonly previewBytes: number;
    readonly truncated: true;
}
/**
 * Ordinary UTF-8 text keeps the original shape. Constrained resources carry a
 * bounded presentation and must never be treated as an editable full buffer.
 */
export interface ReadFileResponse {
    readonly path: string;
    readonly content: string;
    readonly version: string;
    readonly readOnlyPresentation?: ReadOnlyFilePresentation;
}
