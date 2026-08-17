export type MediaPreviewKind = 'image' | 'audio' | 'video';
export interface MediaPreviewDescriptor {
    readonly kind: MediaPreviewKind;
    readonly mimeType: string;
}
/** Strict extension allowlist shared by the Host transport and browser view. */
export declare function mediaPreviewDescriptor(path: string): MediaPreviewDescriptor | undefined;
