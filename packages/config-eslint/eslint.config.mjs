// Lints this package's own JavaScript config files with the same base rules it exports.
import { base } from './base.js';

export default base({ tsconfigRootDir: import.meta.dirname });
