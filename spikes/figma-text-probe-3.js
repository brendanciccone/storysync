// The live text probe, call 3 of 3 (2026-10-09): which platform faces
// Figma's plugin context lacks, which cli/fonts.ts's PLATFORM_FACES lists.
// Read only, from the probe's page. Its response is
// fixtures/figma-text-probe.json `call3`.
const PAGE = 'storysync probe 2';
const page = figma.root.children.find((p) => p.name === PAGE);
if (!page || page.getSharedPluginData('storysync', 'probe2') !== '1') throw new Error('no probe page');
await figma.setCurrentPageAsync(page);
const families = new Set((await figma.listAvailableFontsAsync()).map((f) => f.fontName.family));
const ask = ['SF Pro', 'SF Pro Text', 'SF Pro Display', 'SF Mono', 'SFMono-Regular', 'San Francisco', 'Segoe UI', 'Segoe UI Variable', 'Helvetica Neue', 'Helvetica', 'Arial', 'Arimo', 'Menlo', 'Monaco', 'Consolas', 'Courier New', 'Courier', 'Courier Prime', 'Liberation Mono', 'Liberation Sans', 'Lucida Grande', 'Lucida Console', 'DejaVu Sans', 'DejaVu Sans Mono', 'Georgia', 'Times New Roman', 'Times', 'Tinos', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Cascadia Code', 'Cascadia Mono', 'Ubuntu', 'Ubuntu Mono', 'Cantarell', 'Oxygen', 'Roboto', 'Noto Sans', 'Fira Sans', 'Open Sans', 'Inter', 'Roboto Mono', 'Noto Serif', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'system-ui', 'sans-serif'];
return { total: families.size, has: ask.filter((f) => families.has(f)), lacks: ask.filter((f) => !families.has(f)) };
