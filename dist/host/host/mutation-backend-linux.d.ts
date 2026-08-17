import { type MutationBackend } from './mutation-backend.js';
/**
 * Create the Linux handle-relative backend only after openat2, descriptor
 * identity evidence, and exclusive file/directory creation pass a real
 * runtime witness. Rename and delete remain fail-closed because their POSIX
 * commit syscalls cannot bind the selected name atomically to an open fd.
 */
export declare function createLinuxMutationBackend(): Promise<MutationBackend>;
