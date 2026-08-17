/** Error safe to project across the local HTTP/WebSocket boundary. */
export declare class IdeHostError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status?: number, options?: ErrorOptions);
}
export declare function hostError(error: unknown): IdeHostError;
