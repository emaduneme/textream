'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  outputDir: require('path').join(__dirname, '..', '..', 'test-results'),
});
