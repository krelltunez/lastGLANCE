import { describe, it, expect } from 'vitest';
import { shouldQuitOnAllWindowsClosed } from './startupQuit.js';

// From dayGLANCE's regression test for the Windows/Linux "installs but never
// launches" bug: a hidden window destroyed BEFORE the main window exists fires
// window-all-closed with zero real windows, and the handler must not quit then.

describe('shouldQuitOnAllWindowsClosed', () => {
  describe('macOS: never quits on window-all-closed (stays in the dock)', () => {
    it('does not quit before the main window is created', () => {
      expect(shouldQuitOnAllWindowsClosed('darwin', false)).toBe(false);
    });
    it('does not quit after the main window is created either', () => {
      expect(shouldQuitOnAllWindowsClosed('darwin', true)).toBe(false);
    });
  });

  describe('Windows/Linux: must survive transient startup windows', () => {
    it('does NOT quit before the main window exists', () => {
      expect(shouldQuitOnAllWindowsClosed('win32', false)).toBe(false);
      expect(shouldQuitOnAllWindowsClosed('linux', false)).toBe(false);
    });

    it('DOES quit once the main window has been created and all windows later close', () => {
      expect(shouldQuitOnAllWindowsClosed('win32', true)).toBe(true);
      expect(shouldQuitOnAllWindowsClosed('linux', true)).toBe(true);
    });
  });
});
