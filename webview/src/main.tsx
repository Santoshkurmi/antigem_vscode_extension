// Entry point. The mock shim must be imported before anything that imports host.ts: in a browser with `?mock` it
// makes the page look like a VS Code webview (acquireVsCodeApi + window messages) driven by dev/mock.ts.
import './dev/vscodeEmulation';
import './dev/installMock';
import './vscodeReset';
import './state/jarvis';
import { render } from 'solid-js/web';
import { App } from './App';
import { initTheme } from './theme';
import { startHost } from './state/store';
import 'katex/dist/katex.min.css';
import './styles/theme.css';
import './styles/base.css';
import './styles/chat.css';
import './styles/markdown.css';
import './styles/input.css';
import './styles/drawer.css';
import './styles/panels.css';
import './styles/settings.css';
import './styles/media.css';
import './styles/context.css';
import './styles/accounts.css';
import './styles/agentsetup.css';
import './styles/notes.css';
import './styles/jarvis.css';
import './styles/jarvispanel.css';

initTheme();
let root = document.getElementById('root');
if (!root) {
  root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
}
render(() => <App />, root);
startHost();

// the launch splash (index.html) fades once the UI has painted, after the crown has lifted into place
const splash = document.getElementById('splash');
if (splash) {
  const hide = () => {
    splash.classList.add('gone');
    setTimeout(() => splash.remove(), 300);
  };
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(hide, Math.max(0, 480 - performance.now()))));
}
