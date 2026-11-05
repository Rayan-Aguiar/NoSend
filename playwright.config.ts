import { defineConfig } from '@playwright/test';

export default defineConfig({
  timeout: 30_000,
  reporter: [['list']],
  projects: [
    { name: 'unit', testDir: 'test/unit' },
    // E2E compartilham o perfil/extensão por teste; rodam em série para evitar interferência.
    { name: 'e2e', testDir: 'test/e2e', fullyParallel: false, workers: 1 } as any,
  ],
  workers: 1,
});
