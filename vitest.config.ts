import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { pool: 'forks', execArgv: ['--no-warnings=ExperimentalWarning'], testTimeout: 15000 } });
