'use client';

import { useState } from 'react';

// Copy the deliverable (U-04): the prompt or the message, as one block. Says what it did;
// when the clipboard is not available it says so instead of pretending.

export function CopyButton({
  text,
  label,
  done,
  failed,
}: {
  text: string;
  label: string;
  done: string;
  failed: string;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      setState('failed');
    }
  };
  return (
    <button type="button" className="act-c" onClick={() => void copy()} data-copy={state}>
      {state === 'done' ? done : state === 'failed' ? failed : label}
    </button>
  );
}
