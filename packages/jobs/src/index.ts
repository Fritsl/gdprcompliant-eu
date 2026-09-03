// @gc/jobs — the durable job queue (F-06).
//
//   defineJob   a name, a Zod payload, and for long jobs a Zod progress shape
//   JobQueue    enqueue, work, status, deadLetters; pg-boss underneath, swappable

export const PACKAGE = '@gc/jobs';

export * from './define.js';
export * from './queue.js';
