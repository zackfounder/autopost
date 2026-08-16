/**
 * The visual setup wizard.
 *
 *   npm run setup
 *
 * Opens a browser at a throwaway server on 127.0.0.1 and walks through the key,
 * the LinkedIn login, and the first scheduled post. `npm run setup:cli` is the
 * same flow in the terminal.
 */
import { startWizard } from '../src/setup/wizard.ts';

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`\nnode ${process.versions.node} is too old — this needs 22.5 or newer (it uses the`);
  console.error('built-in node:sqlite). Install it with `nvm install 22` or from nodejs.org.\n');
  process.exit(1);
}

const flag = process.argv.indexOf('--port');
startWizard(flag >= 0 ? Number(process.argv[flag + 1]) : 4311);
