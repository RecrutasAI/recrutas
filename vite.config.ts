import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './client/src'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
  // Add the 'test' configuration block here
  test: {
    // This will now be respected
    environment: 'jsdom',
    globals: true, // This avoids needing to import describe, it, etc.
    setupFiles: './client/src/setupTests.ts', // Correct path to your setup file
    include: ['client/src/**/*.test.{ts,tsx}'], // Scopes tests to the client folder
    // Worker threads instead of the default child processes: CI intermittently
    // failed AFTER every test passed, with tinypool's "Channel closed"
    // (ERR_IPC_CHANNEL_CLOSED) as a forked worker shut down. Threads have no
    // IPC channel to lose.
    pool: 'threads',
  },
});