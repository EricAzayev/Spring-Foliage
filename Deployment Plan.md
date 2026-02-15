# Deployment Plan for Spring Foliage Map

This plan outlines the steps to build and deploy the static React/Vite frontend.

## User Review Required

> [!IMPORTANT]
> **MapTiler API Key**: You will need to provide your MapTiler API key during deployment. If using a service like Vercel or Netlify, this should be set as an environment variable named `VITE_MAPTILER_KEY`.

> [!WARNING]
> **Large Assets**: The `public/tiles` directory contains a large number of images. Ensure your hosting provider supports projects of this size (e.g., GitHub Pages has a 1GB limit).

> [!TIP]
> **NPM Permissions**: If you encounter `EACCES` errors when installing global packages (like Vercel CLI), you can use `npx` to run them without a global installation: `npx vercel`.

## Proposed Changes

### Build and Preparation

1. **Install Dependencies**: Run `npm install` in the `client` directory.
2. **Environment Configuration**: Ensure `VITE_MAPTILER_KEY` is available in your environment or a `.env` file.
3. **Build**: Run `npm run build` in the `client` directory to generate the production-ready `dist` folder.

### Deployment Options

#### Option 1: Vercel (Recommended)
1. In the `client` folder, run:
   ```bash
   npx vercel
   ```
2. Follow the prompts to log in and set up your project.
3. Add `VITE_MAPTILER_KEY` when asked for environment variables.

#### Option 2: GitHub Pages
1. Install `gh-pages` as a dev dependency:
   ```bash
   cd client
   npm install --save-dev gh-pages
   ```
2. Update `package.json` with `"homepage": "https://<username>.github.io/<repository-name>/"`.
3. Add deployment scripts to `package.json`:
   ```json
   "predeploy": "npm run build",
   "deploy": "gh-pages -d dist"
   ```
4. Run `npm run deploy`.

## Verification Plan

### Automated Tests
- Run `npm run build` to ensure the project builds without errors.
- Run `npm run preview` locally in the `client` folder to verify the production build works as expected.

### Manual Verification
- Check the deployed URL to ensure the map loads correctly.
- Verify that the date slider updates the foliage tiles as expected.
- Confirm 3D view and CPU mode function correctly on the live site.
