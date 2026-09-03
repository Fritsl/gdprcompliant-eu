import type { z } from 'zod';

// A job is declared once, with the shape of its payload and, for long jobs, the shape of
// the progress it checkpoints. Everything else in @gc/jobs is generic over the definition,
// so a worker never sees an unvalidated payload and a checkpoint never stores an
// unvalidated shape.

export interface JobDefinition<P, S = never> {
  readonly name: string;
  readonly payload: z.ZodType<P>;
  readonly progress?: z.ZodType<S>;
  // Attempts after the first before the job is dead-lettered.
  readonly retryLimit: number;
  // Seconds a job may sit active without completing before a restart takes it over.
  readonly expireInSeconds: number;
}

export interface DefineJobOptions<P, S> {
  name: string;
  payload: z.ZodType<P>;
  progress?: z.ZodType<S>;
  retryLimit?: number;
  expireInSeconds?: number;
}

export const JOB_NAME = /^[a-z][a-z0-9-]{1,62}$/;

export function defineJob<P, S = never>(options: DefineJobOptions<P, S>): JobDefinition<P, S> {
  if (!JOB_NAME.test(options.name)) throw new Error(`not a job name: ${options.name}`);
  return {
    name: options.name,
    payload: options.payload,
    ...(options.progress ? { progress: options.progress } : {}),
    retryLimit: options.retryLimit ?? 2,
    expireInSeconds: options.expireInSeconds ?? 15 * 60,
  };
}

export const deadLetterName = (name: string): string => `${name}--dead`;
