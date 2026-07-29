/**
 * The run-cancellation token. The contract that matters: outside the TUI no
 * scope is ever armed, and every function must then behave exactly as the
 * code it replaced did (a no-op check, a plain setTimeout) — a plain CLI run
 * must not change behavior because this module exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { beginCancelScope, cancellableSleep, isCancelRequested, requestCancel, RunCancelledError, throwIfCancelled } from '../src/process/cancelScope.js';

test('with no scope armed, the boundary check is a no-op and cancelling does nothing', () => {
  assert.doesNotThrow(() => throwIfCancelled());
  requestCancel();
  assert.equal(isCancelRequested(), false);
  assert.doesNotThrow(() => throwIfCancelled());
});

test('with no scope armed, cancellableSleep is a plain timeout', async () => {
  const started = Date.now();
  await cancellableSleep(20);
  assert.ok(Date.now() - started >= 15, 'an unarmed sleep must actually wait');
});

test('an armed scope throws at the next boundary once cancel is requested', () => {
  const dispose = beginCancelScope();
  try {
    assert.doesNotThrow(() => throwIfCancelled(), 'arming alone must not cancel anything');
    requestCancel();
    assert.equal(isCancelRequested(), true);
    assert.throws(() => throwIfCancelled(), RunCancelledError);
  } finally {
    dispose();
  }
});

test('cancellableSleep rejects as soon as cancel is requested, instead of waiting out the interval', async () => {
  const dispose = beginCancelScope();
  try {
    const started = Date.now();
    const sleeping = cancellableSleep(60_000);
    requestCancel();
    await assert.rejects(() => sleeping, RunCancelledError);
    assert.ok(Date.now() - started < 1000, 'the poll interval must not be waited out');
  } finally {
    dispose();
  }
});

test('a sleep started after the cancel rejects immediately', async () => {
  const dispose = beginCancelScope();
  try {
    requestCancel();
    await assert.rejects(() => cancellableSleep(60_000), RunCancelledError);
  } finally {
    dispose();
  }
});

test('an uncancelled sleep resolves normally and leaves no waiter behind', async () => {
  const dispose = beginCancelScope();
  try {
    await cancellableSleep(10);
    // Cancelling afterwards must not reject anything retroactively.
    assert.doesNotThrow(() => requestCancel());
  } finally {
    dispose();
  }
});

test('disposing a scope disarms it, so a cancel requested after the run does nothing', () => {
  const dispose = beginCancelScope();
  dispose();
  requestCancel();
  assert.equal(isCancelRequested(), false);
  assert.doesNotThrow(() => throwIfCancelled());
});

test('a stale disposer cannot disarm the run that replaced it', () => {
  const stale = beginCancelScope();
  const dispose = beginCancelScope();
  try {
    stale();
    requestCancel();
    assert.equal(isCancelRequested(), true, 'the current run must still be cancellable');
  } finally {
    dispose();
  }
});

test('each run starts uncancelled, even after a cancelled one', () => {
  const first = beginCancelScope();
  requestCancel();
  first();
  const second = beginCancelScope();
  try {
    assert.equal(isCancelRequested(), false);
    assert.doesNotThrow(() => throwIfCancelled());
  } finally {
    second();
  }
});
