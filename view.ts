import { ItemView, WorkspaceLeaf, SearchComponent, Notice, TFile } from 'obsidian';
import SemanticPlannerPlugin, { BucketItem } from './main';

export const SEMANTIC_NAVIGATOR_VIEW = "semantic-navigator-view";

export class SemanticNavigatorView extends ItemView {
    plugin: SemanticPlannerPlugin;
    searchComponent: SearchComponent;
    listContainer: HTMLElement;
    currentFilter: string = "";

    constructor(leaf: WorkspaceLeaf, plugin: SemanticPlannerPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() {
        return SEMANTIC_NAVIGATOR_VIEW;
    }

    getDisplayText() {
        return "Semantic Navigator";
    }

    getIcon() {
        return "compass";
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('semantic-navigator-view');

        // Search Input UI
        const searchContainer = container.createEl("div", { cls: "search-input-container" });
        searchContainer.style.marginBottom = "10px";
        
        this.searchComponent = new SearchComponent(searchContainer);
        this.searchComponent.setPlaceholder("Search documents...");
        this.searchComponent.onChange((value) => {
            this.currentFilter = value.toLowerCase();
            this.renderList();
        });

        // List UI
        this.listContainer = container.createEl("div", { cls: "semantic-navigator-list" });
        this.listContainer.style.overflowY = "auto";
        this.listContainer.style.height = "calc(100% - 40px)";
        
        // Listen to active leaf changes to update the navigator for the focused canvas
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', async (leaf) => {
                if (leaf && leaf.view.getViewType() === 'canvas') {
                    const file = (leaf.view as any).file as TFile;
                    if (file) {
                        await this.loadDataForCanvas(file);
                    }
                }
            })
        );
        
        await this.tryLoadCurrentCanvas();
    }

    async onClose() {
        // cleanup
    }

    async tryLoadCurrentCanvas() {
        // 1. Check if the currently active file is a canvas
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'canvas') {
            await this.loadDataForCanvas(activeFile);
            return;
        } 
        
        // 2. Check if there's any canvas open in the workspace
        const canvasLeaves = this.app.workspace.getLeavesOfType("canvas");
        if (canvasLeaves.length > 0) {
            const targetCanvas = (canvasLeaves[0].view as any).file as TFile;
            if (targetCanvas) {
                await this.loadDataForCanvas(targetCanvas);
                return;
            }
        }

        // 3. Fallback: render current cache (from generation) or show empty state
        await this.renderList();
    }

    async loadDataForCanvas(canvasFile: TFile) {
        const mdFileName = canvasFile.path.replace(/\.canvas$/i, '.md');
        const file = this.app.vault.getAbstractFileByPath(mdFileName);
        
        if (file && file instanceof TFile) {
            const data = await this.parseMarkdownIndex(file);
            if (data) {
                this.plugin.lastCanvasData = data;
                await this.renderList();
            }
        }
    }

    async parseMarkdownIndex(file: TFile): Promise<{ [key: string]: BucketItem[] } | null> {
        try {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');
            const data: { [key: string]: BucketItem[] } = {};
            let currentAnchor = "";

            for (const line of lines) {
                if (line.startsWith('## ')) {
                    currentAnchor = line.replace('## ', '').trim();
                    data[currentAnchor] = [];
                } else if (line.startsWith('- [[') && currentAnchor) {
                    // Match: - [[Filename]] (Sim: 92%)
                    const match = line.match(/- \[\[(.*?)\]\] \(Sim: (\d+)%\)/);
                    if (match) {
                        const baseName = match[1];
                        const simStr = match[2];
                        // Get the exact file path from the basename
                        const targetFile = this.app.metadataCache.getFirstLinkpathDest(baseName, "");
                        if (targetFile) {
                            data[currentAnchor].push({
                                name: targetFile.basename + '.md',
                                path: targetFile.path,
                                similarity: parseInt(simStr, 10) / 100,
                                vector: [] // Vector is not needed for the UI
                            });
                        }
                    }
                }
            }
            return Object.keys(data).length > 0 ? data : null;
        } catch (e) {
            console.error("Failed to parse Markdown index", e);
            return null;
        }
    }

    async renderList() {
        this.listContainer.empty();

        const data = this.plugin.lastCanvasData;
        
        if (!data) {
            this.listContainer.createEl("p", { text: "No Semantic Canvas found. Open a canvas generated by Semantic Planner.", cls: "nav-empty-state" });
            return;
        }

        let hasResults = false;

        for (const [anchorName, docs] of Object.entries(data)) {
            // Apply text filtering (by file name or anchor name)
            const filteredDocs = docs.filter(doc => 
                doc.name.toLowerCase().includes(this.currentFilter) || 
                anchorName.toLowerCase().includes(this.currentFilter)
            );

            if (filteredDocs.length === 0) continue;
            hasResults = true;

            const groupEl = this.listContainer.createEl("div", { cls: "semantic-group" });
            groupEl.style.marginBottom = "16px";
            
            const titleEl = groupEl.createEl("h4", { text: anchorName });
            titleEl.style.margin = "0 0 8px 0";
            titleEl.style.borderBottom = "1px solid var(--background-modifier-border)";
            titleEl.style.paddingBottom = "4px";

            // Sort by similarity descending
            filteredDocs.sort((a, b) => b.similarity - a.similarity);

            filteredDocs.forEach(doc => {
                const itemEl = groupEl.createEl("div", { cls: "semantic-item" });
                itemEl.style.display = "flex";
                itemEl.style.alignItems = "center";
                itemEl.style.gap = "6px";
                itemEl.style.marginBottom = "6px";
                itemEl.style.fontSize = "0.9em";

                // Locate Button
                const btn = itemEl.createEl("button", { text: "Locate" });
                btn.style.cursor = "pointer";
                btn.style.padding = "2px 6px";
                btn.onclick = () => this.locateOnCanvas(doc.path);

                // Document Title Link
                const linkEl = itemEl.createEl("a", { 
                    cls: "internal-link",
                    text: doc.name.replace('.md', '')
                });
                linkEl.setAttribute("data-href", doc.path);
                linkEl.style.cursor = "pointer"; // Indicate clickability on hover
                
                // Since raw HTML inside ItemView doesn't automatically bind to native Obsidian events,
                // we manually trigger the native openLinkText API.
                linkEl.onclick = async (e) => {
                    e.preventDefault();
                    // Open document in a new tab (split view)
                    await this.app.workspace.openLinkText(doc.path, "", true);
                };
                
                // Similarity percentage
                const simPercent = Math.round(doc.similarity * 100);
                itemEl.createEl("span", { text: `(${simPercent}%)`, cls: "semantic-sim" });
            });
        }

        if (!hasResults) {
            this.listContainer.createEl("p", { text: "No results found.", cls: "nav-empty-state" });
        }
    }

    async locateOnCanvas(targetPath: string) {
        // Find active canvas view
        const activeLeaves = this.app.workspace.getLeavesOfType("canvas");
        if (activeLeaves.length === 0) {
            new Notice("No canvas is currently open. Please open a canvas first.");
            return;
        }

        // Use the first canvas leaf available
        const canvasView = activeLeaves[0].view as any;
        const canvas = canvasView.canvas;

        if (!canvas) {
            new Notice("Could not find the canvas object.");
            return;
        }

        // Find the node in the canvas that matches the file path
        const nodes = Array.from(canvas.nodes.values()) as any[];
        const targetNode = nodes.find(n => n.file?.path === targetPath);

        if (targetNode) {
            // Select and zoom in on the target node
            canvas.selectOnly(targetNode);
            canvas.zoomToSelection();
        } else {
            new Notice("Could not find the document in the canvas.");
        }
    }
}
