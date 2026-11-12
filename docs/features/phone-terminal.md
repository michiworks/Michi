# Phone and browser terminals

Backend terminals let a browser, phone or remote workspace use a shell on the
machine running that backend. Multiple windows can share one shell. Electron's
local workspace continues to use its native terminal path.

## Behavior

- Phone terminals are off by default. Enable **Settings › Phone access › Terminal**
  on the computer first. Turning it off disconnects phone terminal streams.
- **New pane** lists running backend terminals. Closing a pane ends a terminal
  only when no other window is using it; idle terminals are eventually reclaimed.
- Reconnecting windows request missed output by sequence number. Input uses the
  stream transport, and input with an uncertain delivery result is not resent.
- The last window to type controls the shared terminal's dimensions. Other users
  of that shell are indicated in the pane.
- The phone layout provides Esc, Tab, Ctrl, arrows and common punctuation above
  the keyboard. An exited shell offers **Restart**.

## Requirements and limits

The backend needs a working `node-pty` native module. It is optional so a failed
native build does not prevent Michi from installing; the terminal UI explains
when it is unavailable. Linux installations may need a supported Python version
and a native build toolchain. Hosted multi-user backends do not provide terminals.

Shells run with the host user's account and a filtered environment that excludes
Michi backend secrets. Enable phone terminal access only when you want that phone
to use the host shell. Mobile keyboard behavior and native module loading depend
on the device and deployment; isolated browser tests do not establish physical
phone or packaged-app compatibility.

## Source and tests

- [Backend terminal host](../../backend/src/services/terminalHost.ts)
- [Terminal host tests](../../backend/test/terminalHost.test.ts)
- [Terminal routes and access tests](../../backend/test/terminalRoutes.test.ts)
- [Browser terminal component](../../frontend/src/components/terminal/BackendTerminalPane.tsx)
- [Component tests](../../frontend/src/components/terminal/BackendTerminalPane.test.tsx)
- [Isolated phone browser tests](../../e2e/specs/phone-terminal.spec.ts)
- [Remote setup contracts](../../scripts/remote-setup.test.mjs)
