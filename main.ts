import { Plugin, PluginSettingTab, App, Setting, Notice, WorkspaceLeaf, TFile } from 'obsidian';
import { SemanticNavigatorView, SEMANTIC_NAVIGATOR_VIEW } from './view';
import { pipeline, env } from '@xenova/transformers';
import { EmbeddingCache, MODEL_ID, PIPELINE_VERSION, CachedEmbedding } from './cache';

// Obsidian 일렉트론 브라우저 환경에서 로컬 파일 시스템 탐색 에러를 방지하기 위해 설정
env.allowLocalModels = false;
// WASM 엔진 파일을 로컬이 아닌 CDN에서 가져오도록 강제 지정
if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/';
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.numThreads = 1;
}

// 플러그인 설정 인터페이스 정의
interface AnchorSetting {
    name: string;
    description: string;
}

interface SemanticPlannerSettings {
    anchors: AnchorSetting[];
    similarityThreshold: number;
    edgeSimilarityThreshold: number; // 캔버스 연결선 임계값
    maxEdgeDegree: number; // 노드 당 최대 엣지 연결 개수
    canvasFilename: string; // 출력할 캔버스 파일명
    kmeansK: number;
}

const DEFAULT_SETTINGS: SemanticPlannerSettings = {
    anchors: [
        { name: "LinkedIn", description: "Academic major knowledge, career portfolio expansion, job competency. Data, recommendation, lab, seminar, paper reading, internship, interview preparation, tech log" },
        { name: "Threads", description: "Short-breath thoughts, fragmented inspiration, social, reading logs, essays. Philosophy, reviews, casual doodles, personal reflections" },
        { name: "Blog", description: "Informative archiving, long-form content, information search, troubleshooting. Health management, debugging, error resolution logs" }
    ],
    similarityThreshold: 0.82,
    edgeSimilarityThreshold: 0.88,
    maxEdgeDegree: 3,
    canvasFilename: "Semantic_Board.canvas",
    kmeansK: 4
};

// 코사인 유사도 함수
const cosineSimilarity = (v1: number[], v2: number[]): number => {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < v1.length; i++) {
        dotProduct += v1[i] * v2[i];
        normA += v1[i] * v1[i];
        normB += v2[i] * v2[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

// 정규표현식을 이용한 옵시디언 마크다운 정제 함수
const cleanText = (text: string): string => {
    return text
        .replace(/```[\s\S]*?```/g, '') // 코드 블록 제거
        .replace(/\[\[.*?\]\]/g, '')     // 위키링크 마커 제거
        .replace(/[#*`_\[\]]/g, '')     // 기타 마크다운 기호 제거
        .replace(/\s+/g, ' ')           // 연속된 공백 축소
        .trim();
};

export interface BucketItem {
    name: string;
    path: string;
    vector: number[];
    similarity: number;
}

export default class SemanticPlannerPlugin extends Plugin {
    settings!: SemanticPlannerSettings;
    extractor: any = null;
    lastCanvasData: { [key: string]: BucketItem[] } | null = null;
    cache!: EmbeddingCache;

    // 플러그인 로드 시
    async onload() {
        console.log('Loading Semantic Planner plugin...');
        await this.loadSettings();

        // Vault별 캐시 인스턴스 생성
        this.cache = new EmbeddingCache(this.app.vault.getName());

        // 설정 탭 등록
        this.addSettingTab(new SemanticPlannerSettingTab(this.app, this));

        // 리본 아이콘 추가
        this.addRibbonIcon('layout-dashboard', 'Generate Semantic Canvas', async () => {
            await this.generateSemanticCanvas();
        });

        // 사이드바 토글 리본 아이콘 추가
        this.addRibbonIcon('list', 'Open Semantic Navigator', async () => {
            this.activateView();
        });

        // 캔버스 생성 명령어
        this.addCommand({
            id: 'generate-semantic-canvas',
            name: 'Generate Semantic Canvas',
            callback: async () => {
                await this.generateSemanticCanvas();
            }
        });

        // 사이드바 열기 명령어
        this.addCommand({
            id: 'open-semantic-navigator',
            name: 'Open Semantic Navigator',
            callback: () => {
                this.activateView();
            }
        });

        // 뷰 등록
        this.registerView(SEMANTIC_NAVIGATOR_VIEW, (leaf) => new SemanticNavigatorView(leaf, this));
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(SEMANTIC_NAVIGATOR_VIEW);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            await leaf?.setViewState({ type: SEMANTIC_NAVIGATOR_VIEW, active: true });
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }

    onunload() {
        console.log('Semantic Planner plugin unloaded.');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // 임베딩 추출기 모델을 싱글톤 형태로 확보
    async getExtractor() {
        if (!this.extractor) {
            new Notice('Initializing local AI model (may take 1-2 minutes on first run)...');
            this.extractor = await pipeline('feature-extraction', MODEL_ID);
            new Notice('AI model loaded successfully!');
        }
        return this.extractor;
    }

    // 메인 비즈니스 로직: 문서들을 분석하고 커스텀 앵커별로 배치하여 캔버스 파일 생성
    async generateSemanticCanvas() {
        const t0_start = performance.now();

        try {
            // Stage 1 Benchmark: t_model
            const t_model_start = performance.now();
            const extractor = await this.getExtractor();
            const t_model = performance.now() - t_model_start;

            // 1. Stage 1 Benchmark: t_scan (Vault 파일 stat 열거)
            const t_scan_start = performance.now();
            const mdFiles = this.app.vault.getMarkdownFiles();
            const t_scan = performance.now() - t_scan_start;

            if (mdFiles.length === 0) {
                new Notice('No Markdown files found in the vault to analyze.');
                return;
            }

            new Notice(`Analyzing ${mdFiles.length} notes semantically...`);

            // 2. Stage 1 Benchmark: t_cache_read (IndexedDB bulk read)
            const t_cache_read_start = performance.now();
            const currentPaths = new Set(mdFiles.map(f => f.path));
            const cachedEntries = await this.cache.getMany(mdFiles.map(f => f.path));
            const t_cache_read = performance.now() - t_cache_read_start;

            // Cache hit / miss 분리
            const hitMap = new Map<string, { name: string; path: string; vector: number[] }>();
            const misses: TFile[] = [];
            let cacheHits = 0;
            let skippedDocs = 0;

            for (const file of mdFiles) {
                const cached = cachedEntries.get(file.path);
                if (
                    cached &&
                    cached.mtime === file.stat.mtime &&
                    cached.size === file.stat.size &&
                    cached.modelId === MODEL_ID &&
                    cached.pipelineVersion === PIPELINE_VERSION
                ) {
                    cacheHits++;
                    if (cached.isSkipped) {
                        skippedDocs++;
                    } else {
                        hitMap.set(file.path, {
                            name: file.basename,
                            path: file.path,
                            vector: Array.from(cached.embedding)
                        });
                    }
                } else {
                    misses.push(file);
                }
            }

            // 3. Cache Miss 문서만 읽기, 정제, 임베딩
            let t_read_changed = 0;
            let t_preprocess = 0;
            let t_embed_docs = 0;

            const newEmbeddingsToSave: CachedEmbedding[] = [];
            const newDocsMap = new Map<string, { name: string; path: string; vector: number[] }>();

            if (misses.length > 0) {
                // t_read_changed + t_preprocess + t_embed_docs 분리 측정
                for (const file of misses) {
                    // Read
                    const rStart = performance.now();
                    const rawText = await this.app.vault.read(file);
                    t_read_changed += (performance.now() - rStart);

                    // Preprocess
                    const pStart = performance.now();
                    const cleaned = cleanText(rawText);
                    t_preprocess += (performance.now() - pStart);

                    if (cleaned.length < 10) {
                        skippedDocs++;
                        newEmbeddingsToSave.push({
                            path: file.path,
                            mtime: file.stat.mtime,
                            size: file.stat.size,
                            modelId: MODEL_ID,
                            pipelineVersion: PIPELINE_VERSION,
                            isSkipped: true,
                            embedding: new Float32Array(0)
                        });
                        continue;
                    }

                    // Embed
                    const eStart = performance.now();
                    const output = await extractor(`passage: ${cleaned}`, {
                        pooling: 'mean',
                        normalize: true
                    });
                    t_embed_docs += (performance.now() - eStart);

                    const vectorFloat32 = new Float32Array(output.data);
                    const vectorArray = Array.from(vectorFloat32);

                    newEmbeddingsToSave.push({
                        path: file.path,
                        mtime: file.stat.mtime,
                        size: file.stat.size,
                        modelId: MODEL_ID,
                        pipelineVersion: PIPELINE_VERSION,
                        isSkipped: false,
                        embedding: vectorFloat32
                    });

                    newDocsMap.set(file.path, {
                        name: file.basename,
                        path: file.path,
                        vector: vectorArray
                    });
                }
            }

            // 4. t_cache_write (IndexedDB bulk write + deleted clean)
            const t_cache_write_start = performance.now();
            await this.cache.putMany(newEmbeddingsToSave);
            const deletedPaths = await this.cache.deletePathsNotIn(currentPaths);
            const t_cache_write = performance.now() - t_cache_write_start;

            // 5. Vault 파일 순서에 맞추어 documents 배열 완성
            const documents: { name: string; path: string; vector: number[] }[] = [];
            for (const file of mdFiles) {
                const doc = hitMap.get(file.path) || newDocsMap.get(file.path);
                if (doc) {
                    documents.push(doc);
                }
            }

            // 6. t_embed_anchors (커스텀 앵커 텍스트 임베딩)
            const t_anchor_start = performance.now();
            const anchorsWithVectors = [];
            for (const anchor of this.settings.anchors) {
                const output = await extractor(`query: ${anchor.description}`, {
                    pooling: 'mean',
                    normalize: true
                });
                anchorsWithVectors.push({
                    name: anchor.name,
                    vector: Array.from(output.data)
                });
            }
            const t_embed_anchors = performance.now() - t_anchor_start;

            // 7. t_classify (유사도 비교 후 앵커별 분류)
            const t_classify_start = performance.now();
            const columnBuckets: { [key: string]: BucketItem[] } = {};
            this.settings.anchors.forEach(a => {
                columnBuckets[a.name] = [];
            });

            documents.forEach(doc => {
                let maxSim = -Infinity;
                let bestAnchorName = this.settings.anchors[0].name;

                anchorsWithVectors.forEach(anchor => {
                    const sim = cosineSimilarity(doc.vector, anchor.vector);
                    if (sim > maxSim) {
                        maxSim = sim;
                        bestAnchorName = anchor.name;
                    }
                });

                if (maxSim >= this.settings.similarityThreshold) {
                    columnBuckets[bestAnchorName].push({ ...doc, similarity: maxSim });
                }
            });
            const t_classify = performance.now() - t_classify_start;

            // 8. t_serialize + t_edge (캔버스 뷰 생성 및 엣지 계산)
            const t_edge_start = performance.now();
            const canvasNodes: any[] = [];
            const canvasEdges: any[] = [];

            const cardWidth = 320;
            const cardHeight = 120;
            const columnSpacing = 100;
            const rowSpacing = 40;

            this.settings.anchors.forEach((anchor, colIdx) => {
                const colX = colIdx * (cardWidth + columnSpacing);

                canvasNodes.push({
                    id: `header-${colIdx}`,
                    type: 'text',
                    text: `## ${anchor.name}\n> ${anchor.description}`,
                    x: colX,
                    y: 0,
                    width: cardWidth,
                    height: 80
                });

                const docList = columnBuckets[anchor.name] || [];
                docList.forEach((doc, rowIdx) => {
                    const nodeY = 120 + rowIdx * (cardHeight + rowSpacing);
                    canvasNodes.push({
                        id: `doc-${colIdx}-${rowIdx}`,
                        type: 'file',
                        file: doc.path,
                        x: colX,
                        y: nodeY,
                        width: cardWidth,
                        height: cardHeight
                    });
                });
            });

            // Edge 생성
            let edgeCounter = 0;
            const allEdges: { fromIdx: number, toIdx: number, sim: number }[] = [];
            for (let i = 0; i < documents.length; i++) {
                for (let j = i + 1; j < documents.length; j++) {
                    const sim = cosineSimilarity(documents[i].vector, documents[j].vector);
                    if (sim >= this.settings.edgeSimilarityThreshold) {
                        allEdges.push({ fromIdx: i, toIdx: j, sim });
                    }
                }
            }

            allEdges.sort((a, b) => b.sim - a.sim);

            const nodeDegree = new Array(documents.length).fill(0);
            const MAX_DEGREE = this.settings.maxEdgeDegree;

            for (const edge of allEdges) {
                if (MAX_DEGREE > 0) {
                    if (nodeDegree[edge.fromIdx] >= MAX_DEGREE || nodeDegree[edge.toIdx] >= MAX_DEGREE) {
                        continue;
                    }
                }

                const fromDoc = documents[edge.fromIdx];
                const toDoc = documents[edge.toIdx];

                const fromNodeId = this.findCanvasNodeId(canvasNodes, fromDoc.path);
                const toNodeId = this.findCanvasNodeId(canvasNodes, toDoc.path);

                if (fromNodeId && toNodeId) {
                    const isSameColumn = fromNodeId.split('-')[1] === toNodeId.split('-')[1];

                    canvasEdges.push({
                        id: `edge-${edgeCounter++}`,
                        fromNode: fromNodeId,
                        fromSide: isSameColumn ? 'bottom' : 'right',
                        toNode: toNodeId,
                        toSide: isSameColumn ? 'top' : 'left',
                        label: `${Math.round(edge.sim * 100)}%`
                    });

                    nodeDegree[edge.fromIdx]++;
                    nodeDegree[edge.toIdx]++;
                }
            }
            const t_edge = performance.now() - t_edge_start;

            // 9. t_serialize (직렬화)
            const t_serialize_start = performance.now();
            const canvasData = { nodes: canvasNodes, edges: canvasEdges };

            let outputFileName = this.settings.canvasFilename;
            if (!outputFileName.toLowerCase().endsWith('.canvas')) {
                outputFileName += '.canvas';
            }

            let mdContent = `# Semantic Planner Index\n\n`;
            this.settings.anchors.forEach(anchor => {
                mdContent += `## ${anchor.name}\n`;
                const docs = columnBuckets[anchor.name] || [];
                const sortedDocs = [...docs].sort((a, b) => b.similarity - a.similarity);

                sortedDocs.forEach(doc => {
                    const simPercent = Math.round(doc.similarity * 100);
                    mdContent += `- [[${doc.name.replace('.md', '')}]] (Sim: ${simPercent}%)\n`;
                });
                mdContent += `\n`;
            });
            const mdFileName = outputFileName.replace('.canvas', '.md');
            const t_serialize = performance.now() - t_serialize_start;

            // 10. t_write (Vault 파일 저장)
            const t_write_start = performance.now();
            const existingFile = this.app.vault.getAbstractFileByPath(outputFileName);
            if (existingFile) {
                await this.app.vault.delete(existingFile);
            }
            await this.app.vault.create(outputFileName, JSON.stringify(canvasData, null, 2));

            const existingMdFile = this.app.vault.getAbstractFileByPath(mdFileName);
            if (existingMdFile) {
                await this.app.vault.delete(existingMdFile);
            }
            await this.app.vault.create(mdFileName, mdContent);
            const t_write = performance.now() - t_write_start;

            // 사이드바 업데이트
            this.lastCanvasData = columnBuckets;
            const views = this.app.workspace.getLeavesOfType(SEMANTIC_NAVIGATOR_VIEW);
            if (views.length > 0) {
                (views[0].view as SemanticNavigatorView).renderList();
            }

            const t_total = performance.now() - t0_start;

            // Stage 1 & 2 Benchmark 결과를 콘솔 테이블로 출력
            const totalDocsCount = mdFiles.length;
            const hitRate = totalDocsCount > 0 ? ((cacheHits / totalDocsCount) * 100).toFixed(1) + '%' : '0%';

            console.group('📊 [Semantic Planner Benchmark Report]');
            console.table({
                '1. Model Load (ms)': t_model.toFixed(2),
                '2. Vault Scan (ms)': t_scan.toFixed(2),
                '3. Cache Read (ms)': t_cache_read.toFixed(2),
                '4. File Read Changed (ms)': t_read_changed.toFixed(2),
                '5. Preprocess (ms)': t_preprocess.toFixed(2),
                '6. Embed Docs (ms)': t_embed_docs.toFixed(2),
                '7. Cache Write (ms)': t_cache_write.toFixed(2),
                '8. Embed Anchors (ms)': t_embed_anchors.toFixed(2),
                '9. Classification (ms)': t_classify.toFixed(2),
                '10. Edge Calc (ms)': t_edge.toFixed(2),
                '11. Serialization (ms)': t_serialize.toFixed(2),
                '12. Vault Write (ms)': t_write.toFixed(2),
                'Total Time (ms)': t_total.toFixed(2)
            });

            console.table({
                'Total Documents': totalDocsCount,
                'Cache Hits': cacheHits,
                'Cache Misses': misses.length,
                'Skipped Docs': skippedDocs,
                'Deleted From Cache': deletedPaths.length,
                'Cache Hit Rate': hitRate,
                'Edge Count': canvasEdges.length
            });
            console.groupEnd();

            new Notice(`Success! Generated in ${(t_total / 1000).toFixed(2)}s (Hit Rate: ${hitRate})`);

        } catch (err) {
            console.error(err);
            new Notice('An error occurred while generating the canvas.');
        }
    }

    findCanvasNodeId(nodes: any[], filePath: string): string | null {
        const found = nodes.find(n => n.type === 'file' && n.file === filePath);
        return found ? found.id : null;
    }
}

// 옵시디언 설정 탭 클래스 정의
class SemanticPlannerSettingTab extends PluginSettingTab {
    plugin: SemanticPlannerPlugin;

    constructor(app: App, plugin: SemanticPlannerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Semantic Planner Settings' });
        containerEl.createEl('p', { text: 'Configure custom classification columns (Anchors) based on semantic similarities of your notes.' });

        new Setting(containerEl)
            .setName('Similarity Threshold')
            .setDesc('Only documents with a semantic similarity above this threshold will be placed on the canvas. (Recommended: 0.80 - 0.85)')
            .addText(text => text
                .setValue(String(this.plugin.settings.similarityThreshold))
                .onChange(async (value) => {
                    const parsed = parseFloat(value);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.similarityThreshold = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Edge Similarity Threshold')
            .setDesc('The similarity threshold used for drawing semantic edges between documents. (Recommended: 0.87 - 0.90)')
            .addText(text => text
                .setValue(String(this.plugin.settings.edgeSimilarityThreshold))
                .onChange(async (value) => {
                    const parsed = parseFloat(value);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.edgeSimilarityThreshold = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Max Edge Degree')
            .setDesc('Maximum number of edges per document. Set to 0 to remove the limit and draw all valid edges. (Recommended: 2 - 4)')
            .addText(text => text
                .setValue(String(this.plugin.settings.maxEdgeDegree))
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed) && parsed >= 0) {
                        this.plugin.settings.maxEdgeDegree = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Output Canvas Filename')
            .setDesc('The filename for the generated semantic canvas. If a file with the same name exists, it will be overwritten.')
            .addText(text => text
                .setValue(this.plugin.settings.canvasFilename)
                .onChange(async (value) => {
                    this.plugin.settings.canvasFilename = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: 'Cache Management' });

        new Setting(containerEl)
            .setName('Clear Embedding Cache')
            .setDesc('Clear all cached embeddings in IndexedDB. Next generation will recalculate embeddings for all notes.')
            .addButton(btn => btn
                .setButtonText('Clear Cache')
                .setWarning()
                .onClick(async () => {
                    await this.plugin.cache.clear();
                    new Notice('Embedding cache cleared successfully!');
                }));

        containerEl.createEl('h3', { text: 'Custom Anchor Settings' });

        this.plugin.settings.anchors.forEach((anchor, index) => {
            const s = new Setting(containerEl)
                .setName(`Anchor #${index + 1}: ${anchor.name}`)
                .addText(text => text
                    .setPlaceholder('Anchor Name (e.g., Career & Portfolio)')
                    .setValue(anchor.name)
                    .onChange(async (value) => {
                        anchor.name = value;
                        await this.plugin.saveSettings();
                    }))
                .addTextArea(text => text
                    .setPlaceholder('Semantic features and keywords describing this anchor...')
                    .setValue(anchor.description)
                    .onChange(async (value) => {
                        anchor.description = value;
                        await this.plugin.saveSettings();
                    }));

            s.addButton(btn => btn
                .setButtonText('Delete')
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings.anchors.splice(index, 1);
                    await this.plugin.saveSettings();
                    this.display();
                }));
        });

        new Setting(containerEl)
            .setName('Add New Anchor')
            .addButton(btn => btn
                .setButtonText('Add New Anchor')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.anchors.push({ name: 'New Anchor', description: 'Enter a description and a list of keywords suitable for this classification.' });
                    await this.plugin.saveSettings();
                    this.display();
                }));
    }
}
