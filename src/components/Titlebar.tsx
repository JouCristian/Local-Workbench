import { useEffect, useState } from 'react';
import { Command, Minus, Square, Copy, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '@tauri-apps/api/core';
import { useStore } from '../state';

export function Titlebar() {
  const { report } = useStore();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    const window = getCurrentWindow();
    let disposed = false,
      stop: (() => void) | undefined;
    const update = () =>
      void window
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(report);
    update();
    window
      .onResized(update)
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(report);
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  function action(command: 'minimize' | 'toggleMaximize' | 'close') {
    if (isTauri()) void getCurrentWindow()[command]().catch(report);
  }
  return (
    <header className="titlebar" aria-label="窗口标题栏">
      <div className="titlebar-drag" data-tauri-drag-region>
        <Command size={14} />
        <span>Local Workbench</span>
      </div>
      <div className="window-controls">
        <button type="button" aria-label="最小化窗口" onClick={() => action('minimize')}>
          <Minus size={14} />
        </button>
        <button
          type="button"
          aria-label={maximized ? '还原窗口' : '最大化窗口'}
          onClick={() => action('toggleMaximize')}
        >
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button type="button" aria-label="关闭窗口" onClick={() => action('close')}>
          <X size={15} />
        </button>
      </div>
    </header>
  );
}
