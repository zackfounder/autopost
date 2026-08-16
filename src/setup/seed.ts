import { existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Give this install its own brief and its own template bank.
 *
 * The `.example` files are tracked and will change when you pull; yours are
 * git-ignored and never will. Copying rather than editing the examples in place
 * is what keeps those two facts from colliding.
 */
export function seedConfigFiles(root: string): string[] {
  const made: string[] = [];
  const pairs: [string, string][] = [
    ['instructions/GLOBAL.example.md', 'instructions/GLOBAL.md'],
    ['instructions/linkedin.example.md', 'instructions/linkedin.md'],
    ['instructions/x.example.md', 'instructions/x.md'],
    ['templates/linkedin/bank.example.json', 'templates/linkedin/bank.json'],
    ['templates/x/bank.example.json', 'templates/x/bank.json'],
  ];
  for (const [from, to] of pairs) {
    const src = join(root, from);
    const dest = join(root, to);
    if (existsSync(src) && !existsSync(dest)) {
      copyFileSync(src, dest);
      made.push(to);
    }
  }
  return made;
}
