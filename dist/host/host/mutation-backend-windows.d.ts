import { type MutationBackend } from './mutation-backend.js';
/**
 * Create the x64 Windows handle-relative backend only after its native ABI,
 * identity mapping, no-replace create and rename semantics all succeed.
 * Every unsupported platform or failed probe remains deliberately all-false.
 */
export declare function createWindowsMutationBackend(): Promise<MutationBackend>;
