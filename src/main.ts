import { App } from './app';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const stage = document.getElementById('stage') as HTMLElement;
// Let the veil paint before the (synchronous) world bake starts.
requestAnimationFrame(() => {
  setTimeout(() => {
    const app = new App(canvas, stage);
    app.start();
  }, 30);
});
