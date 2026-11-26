import { mat4, vec3 } from 'gl-matrix';
import { mat4ToArray } from './utils/math';
import { Cloth } from './Cloth';
import { SimpleCloth } from './SimpleCloth';
import type { ClothSimulator } from './sim/ClothSimulator';
import { Ground } from './Ground';
import { Camera } from './Camera';
import floorVertexShaderCode from './shaders/floor.vert.wgsl?raw';
import floorFragmentShaderCode from './shaders/floor.frag.wgsl?raw';
import gridVertexShaderCode from './shaders/grid.vert.wgsl?raw';
import gridFragmentShaderCode from './shaders/grid.frag.wgsl?raw';
import { inchesToOrbitWorld } from './sim/cameraDefaults';
import pbrVertexShaderCode from './shaders/pbr.vert.wgsl?raw';
import pbrFragmentShaderCode from './shaders/pbr.frag.wgsl?raw';
import toneMappingShaderCode from './shaders/tonemapping.wgsl?raw';
import { tonemapIndex } from './render/tonemapping';
import { Environment, shadingModeLabel, type ShadingMode } from './render/environment';
import { cylinderGeometry } from './render/cylinder';
import { MaterialLibrary, PEDESTAL_DARKENING, type MaterialParams } from './render/materials';
import { FabricLibrary, materialForVariant } from './fabrics/library';
import type { ClothFloor } from './sim/ClothSimulator';

export type RenderableCloth = Cloth | SimpleCloth | ClothSimulator;

/** The PBR floor pedestal is 12 inches tall. */
const CYLINDER_HEIGHT_WORLD = inchesToOrbitWorld(12);

/**
 * Vertex layout of the cloth pass: positions, normals, and the optional strain
 * colors. The alpha variants append the per-vertex opacity buffer.
 */
const CLOTH_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
    {
        arrayStride: 12,
        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
    },
    {
        arrayStride: 12,
        attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }],
    },
    {
        arrayStride: 12,
        attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x3' }],
    },
];

/** Texture coordinates, appended after the color (and alpha, when present) buffer. */
const CLOTH_UV_BUFFER: GPUVertexBufferLayout = {
    arrayStride: 8,
    attributes: [{ shaderLocation: 4, offset: 0, format: 'float32x2' }],
};

/**
 * Color target of the translucent-cloth pass: plain source-over blending, and
 * the same format as the canvas. The opaque and blended passes share one shader
 * module and differ in entry point, so both record in the same render pass.
 */
function blendedClothTarget(format: GPUTextureFormat): GPUColorTargetState {
    return {
        format,
        blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
    };
}

/**
 * Flat alpha-blended quad overlay (the quadrant snap grid). Vertices are
 * triangle-list xyz triples in world space.
 */
export type QuadOverlay = {
  cells: Float32Array;
  highlight?: Float32Array | null;
};

export class Renderer {
    private device: GPUDevice;
    private context: GPUCanvasContext;
    private format: GPUTextureFormat;
    private depthTexture: GPUTexture;
    private depthTextureView: GPUTextureView;
    private canvas: HTMLCanvasElement;

    private renderPipeline: GPURenderPipeline | null = null;
    /** Cloth with optional per-vertex strain colors. */
    private clothPipeline: GPURenderPipeline | null = null;
    /**
     * The same cloth pass with per-vertex opacity: the opaque variant drops
     * dimmed fragments, the blended variant keeps only them and leaves depth
     * alone so the fabric behind a ghost still shows through.
     */
    private clothAlphaPipeline: GPURenderPipeline | null = null;
    private clothAlphaBlendPipeline: GPURenderPipeline | null = null;
    private floorPipeline: GPURenderPipeline | null = null;
    private wireframePipeline: GPURenderPipeline | null = null;
    private linePipeline: GPURenderPipeline | null = null;
    /** Alpha-blended quad overlay (quadrant snap grid). */
    private gridPipeline: GPURenderPipeline | null = null;
    private gridUniformBuffer: GPUBuffer | null = null;
    private gridBindGroup: GPUBindGroup | null = null;
    private gridCellBuffer: GPUBuffer | null = null;
    private gridHighlightBuffer: GPUBuffer | null = null;
    private gridCellVertexCount = 0;
    private gridHighlightVertexCount = 0;
    private gridOverlay: QuadOverlay | null = null;
    /** Cloth model + viewProj — do not overwrite mid-frame after cloth draw is encoded. */
    private uniformBuffer: GPUBuffer | null = null;
    /** Sphere collider model matrix. */
    private objectUniformBuffer: GPUBuffer | null = null;
    /** Flat floor model matrix + gradient params. */
    private floorUniformBuffer: GPUBuffer | null = null;
    /** Seam / wireframe overlay model matrix. */
    private overlayUniformBuffer: GPUBuffer | null = null;
    private wireframeUniformBuffer: GPUBuffer | null = null;
    private wireframeLightingBuffer: GPUBuffer | null = null;
    /** Cloth lighting — written once per frame. */
    private lightingBuffer: GPUBuffer | null = null;
    /** Sphere collider lighting. */
    private objectLightingBuffer: GPUBuffer | null = null;
    /** Flat floor lighting. */
    private floorLightingBuffer: GPUBuffer | null = null;
    /** Seam / wireframe overlay lighting (bright unlit colors). */
    private overlayLightingBuffer: GPUBuffer | null = null;

    private vertexShader: GPUShaderModule | null = null;
    private fragmentShader: GPUShaderModule | null = null;
    
    private wireframeMode: boolean = false;
    private wireframeColor: [number, number, number] = [0.0, 1.0, 1.0]; // Bright cyan wireframe

    /** Wireframe / simple / PBR — cycled by the viewport's shading control. */
    private shading: ShadingMode = 'simple';
    private pbrPipeline: GPURenderPipeline | null = null;
    private pbrClothPipeline: GPURenderPipeline | null = null;
    private pbrClothAlphaPipeline: GPURenderPipeline | null = null;
    private pbrClothAlphaBlendPipeline: GPURenderPipeline | null = null;
    /** HDRI background + light probe, shared by every viewport. */
    private environment: Environment | null = null;
    private environmentUnsubscribe: (() => void) | null = null;
    /** Rebuilt whenever the environment replaces its textures. */
    private pbrEnvBindGroups = new WeakMap<GPURenderPipeline, GPUBindGroup>();
    private backgroundBindGroupCache: GPUBindGroup | null = null;
    /** inverseViewProj (64 bytes) + eye + blur level + exposure + tonemap mode. */
    private backgroundUniformBuffer: GPUBuffer | null = null;
    /** Cloth surface roughness in PBR mode (used until a library is attached). */
    private surfaceRoughness = 0.65;
    private exposure = 1.0;
    /** Shared scene materials; without one the demo's own colours are used. */
    private materials: MaterialLibrary | null = null;
    /** The studio's fabrics, and which variant each piece was given. */
    private fabrics: FabricLibrary | null = null;
    private fabricAssignments = new Map<string, string>();
    /** Per-fabric albedo textures, created lazily as their variants are drawn. */
    private fabricTextures = new Map<
        string,
        {
            url: string | null;
            loading: string | null;
            texture: GPUTexture | null;
            view: GPUTextureView | null;
            options: GPUBuffer;
            groups: WeakMap<GPURenderPipeline, GPUBindGroup>;
        }
    >();
    /** Per-piece lighting blocks, grown when a drape has more pieces. */
    private clothLightingBytes = 256;
    /** Index runs per cloth, keyed by its index buffer (stable for a mesh). */
    private clothRunsCache = new WeakMap<
        GPUBuffer,
        Array<{ pieceId: string; first: number; count: number }>
    >();
    private clothLightingGroups = new WeakMap<GPURenderPipeline, Map<number, GPUBindGroup>>();
    /** Cloth albedo image and the group-2 bindings that carry it into the shaders. */
    private albedoSampler: GPUSampler | null = null;
    private albedoOptionsBuffer: GPUBuffer | null = null;
    private defaultAlbedoTexture: GPUTexture | null = null;
    private defaultAlbedoView: GPUTextureView | null = null;
    private albedoTexture: GPUTexture | null = null;
    private albedoTextureView: GPUTextureView | null = null;
    /** URL currently uploaded (null = the white fallback), and the one loading. */
    private albedoTextureUrl: string | null = null;
    private albedoTextureLoading: string | null = null;
    private albedoBindGroups = new WeakMap<GPURenderPipeline, GPUBindGroup>();
    /** Floor pedestal drawn in PBR mode, in place of the flat floor. */
    private cylinder: {
        radius: number;
        positionBuffer: GPUBuffer;
        normalBuffer: GPUBuffer;
        indexBuffer: GPUBuffer;
        indexCount: number;
    } | null = null;

    // inital lighting and color parameters
    private light1Color: [number, number, number] = [0.96, 0.98, 1.0];
    private light1Position: [number, number, number] = [1, -1.5 + inchesToOrbitWorld(24), 2];
    private light2Color: [number, number, number] = [0.4, 0.4, 0.4];
    private light2Position: [number, number, number] = [-1, 5, -2];
    private clothColor: [number, number, number] = [0.9, 0.01, 0.01];
    private groundColor: [number, number, number] = [0.5, 0.4, 0.35];

    constructor(
        device: GPUDevice,
        context: GPUCanvasContext,
        format: GPUTextureFormat,
        depthTexture: GPUTexture,
        depthTextureView: GPUTextureView,
        canvas: HTMLCanvasElement
    ) {
        this.device = device;
        this.context = context;
        this.format = format;
        this.depthTexture = depthTexture;
        this.depthTextureView = depthTextureView;
        this.canvas = canvas;
    }

    async initialize(vertexShaderCode: string, fragmentShaderCode: string): Promise<void> {
        // Create shader modules
        this.vertexShader = this.device.createShaderModule({ code: vertexShaderCode });
        this.fragmentShader = this.device.createShaderModule({ code: fragmentShaderCode });

        // Create uniform buffers
        // Uniforms: viewProj (16 floats) + model (16 floats) = 32 floats * 4 bytes = 128 bytes
        // Separate buffers per draw group: queue.writeBuffer before submit would otherwise
        // leave every draw seeing only the *last* written contents of a shared buffer.
        this.uniformBuffer = this.device.createBuffer({
            size: 128,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.objectUniformBuffer = this.device.createBuffer({
            size: 128,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.floorUniformBuffer = this.device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.overlayUniformBuffer = this.device.createBuffer({
            size: 128,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        // viewProj (64) + color (16)
        this.gridUniformBuffer = this.device.createBuffer({
            size: 80,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Lighting uniforms: 6 vec3s = 18 floats * 4 bytes = 72 bytes, but align to 256 for safety
        this.lightingBuffer = this.device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.objectLightingBuffer = this.device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.floorLightingBuffer = this.device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.overlayLightingBuffer = this.device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Cloth albedo image: a sampler, the 1x1 white texture every draw binds
        // until a real image is uploaded, and the flag that says which is live.
        this.albedoSampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat',
        });
        this.albedoOptionsBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.defaultAlbedoTexture = this.device.createTexture({
            size: [1, 1, 1],
            format: 'rgba8unorm-srgb',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.device.queue.writeTexture(
            { texture: this.defaultAlbedoTexture },
            new Uint8Array([255, 255, 255, 255]),
            { bytesPerRow: 4 },
            { width: 1, height: 1 }
        );
        this.defaultAlbedoView = this.defaultAlbedoTexture.createView();
        this.writeAlbedoOptions();
        // The wireframe overlay shares this pass with the seam overlay; every
        // queue.writeBuffer lands before the whole command buffer, so the two
        // need separate uniforms to keep their own colours.
        this.wireframeUniformBuffer = this.device.createBuffer({
            size: 128,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.wireframeLightingBuffer = this.device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Create render pipeline (filled triangles)
        this.renderPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.vertexShader,
                entryPoint: 'main',
                buffers: [
                    {
                        arrayStride: 12, // 3 floats * 4 bytes
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
                        ],
                    },
                    {
                        arrayStride: 12, // 3 floats * 4 bytes
                        attributes: [
                            { shaderLocation: 1, offset: 0, format: 'float32x3' }, // normal
                        ],
                    },
                ],
            },
            fragment: {
                module: this.fragmentShader,
                entryPoint: 'main',
                targets: [{ format: this.format }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less-equal',
                format: 'depth24plus',
            },
        });

        this.clothPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.vertexShader,
                entryPoint: 'mainColored',
                buffers: [...CLOTH_VERTEX_BUFFERS, CLOTH_UV_BUFFER],
            },
            fragment: {
                module: this.fragmentShader,
                entryPoint: 'mainColored',
                targets: [{ format: this.format }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less-equal',
                format: 'depth24plus',
            },
        });

        const clothAlphaBuffers: GPUVertexBufferLayout[] = [
            ...CLOTH_VERTEX_BUFFERS,
            {
                arrayStride: 4,
                attributes: [{ shaderLocation: 3, offset: 0, format: 'float32' }],
            },
            CLOTH_UV_BUFFER,
        ];
        this.clothAlphaPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.vertexShader,
                entryPoint: 'mainColorAlpha',
                buffers: clothAlphaBuffers,
            },
            fragment: {
                module: this.fragmentShader,
                entryPoint: 'mainColorAlpha',
                targets: [{ format: this.format }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less-equal',
                format: 'depth24plus',
            },
        });
        this.clothAlphaBlendPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.vertexShader,
                entryPoint: 'mainColorAlpha',
                buffers: clothAlphaBuffers,
            },
            fragment: {
                module: this.fragmentShader,
                entryPoint: 'mainColorAlphaBlend',
                targets: [blendedClothTarget(this.format)],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                depthWriteEnabled: false,
                depthCompare: 'less-equal',
                format: 'depth24plus',
            },
        });

        const floorVertexShader = this.device.createShaderModule({ code: floorVertexShaderCode });
        const floorFragmentShader = this.device.createShaderModule({ code: floorFragmentShaderCode });
        this.floorPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: floorVertexShader,
                entryPoint: 'main',
                buffers: [
                    {
                        arrayStride: 12,
                        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
                    },
                    {
                        arrayStride: 12,
                        attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }],
                    },
                ],
            },
            fragment: {
                module: floorFragmentShader,
                entryPoint: 'main',
                targets: [{ format: this.format }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less-equal',
                format: 'depth24plus',
            },
        });

        // Create wireframe pipeline (triangles for quad-based wireframe)
        this.wireframePipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.vertexShader,
                entryPoint: 'main',
                buffers: [
                    {
                        arrayStride: 12, // 3 floats * 4 bytes
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
                        ],
                    },
                    {
                        arrayStride: 12, // 3 floats * 4 bytes
                        attributes: [
                            { shaderLocation: 1, offset: 0, format: 'float32x3' }, // normal
                        ],
                    },
                ],
            },
            fragment: {
                module: this.fragmentShader,
                entryPoint: 'main',
                targets: [{ format: this.format }],
            },
            primitive: {
                topology: 'triangle-list', // Use triangles for quad-based wireframe
                cullMode: 'none',
            },
            depthStencil: {
                depthWriteEnabled: false, // Don't write depth for wireframe
                depthCompare: 'less', // Render wireframe when closer or equal (ensures it's visible)
                format: 'depth24plus',
            },
        });

        // PBR twins of the two cloth pipelines: same vertex layouts, same group 0,
        // plus the environment's textures in group 1.
        const pbrVertexShader = this.device.createShaderModule({ code: pbrVertexShaderCode });
        // The tone mapping operators are shared with the background shader, so
        // they are prepended rather than duplicated in the .wgsl file.
        const pbrFragmentShader = this.device.createShaderModule({
            code: `${toneMappingShaderCode}\n${pbrFragmentShaderCode}`,
        });
        const pbrVertexBuffers: GPUVertexBufferLayout[] = [
            {
                arrayStride: 12,
                attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
            },
            {
                arrayStride: 12,
                attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }],
            },
        ];
        this.pbrPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: pbrVertexShader,
                entryPoint: 'main',
                buffers: pbrVertexBuffers,
            },
            fragment: {
                module: pbrFragmentShader,
                entryPoint: 'main',
                targets: [{ format: this.format }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less-equal',
                format: 'depth24plus',
            },
        });
        this.pbrClothPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: pbrVertexShader,
                entryPoint: 'mainColored',
                buffers: [
                    ...pbrVertexBuffers,
                    {
                        arrayStride: 12,
                        attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x3' }],
                    },
                    CLOTH_UV_BUFFER,
                ],
            },
            fragment: {
                module: pbrFragmentShader,
                entryPoint: 'mainColored',
                targets: [{ format: this.format }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less-equal',
                format: 'depth24plus',
            },
        });

        const pbrClothAlphaBuffers: GPUVertexBufferLayout[] = [
            ...pbrVertexBuffers,
            {
                arrayStride: 12,
                attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x3' }],
            },
            {
                arrayStride: 4,
                attributes: [{ shaderLocation: 3, offset: 0, format: 'float32' }],
            },
            CLOTH_UV_BUFFER,
        ];
        this.pbrClothAlphaPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: pbrVertexShader,
                entryPoint: 'mainColorAlpha',
                buffers: pbrClothAlphaBuffers,
            },
            fragment: {
                module: pbrFragmentShader,
                entryPoint: 'mainColorAlpha',
                targets: [{ format: this.format }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less-equal',
                format: 'depth24plus',
            },
        });
        this.pbrClothAlphaBlendPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: pbrVertexShader,
                entryPoint: 'mainColorAlpha',
                buffers: pbrClothAlphaBuffers,
            },
            fragment: {
                module: pbrFragmentShader,
                entryPoint: 'mainColorAlphaBlend',
                targets: [blendedClothTarget(this.format)],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: {
                depthWriteEnabled: false,
                depthCompare: 'less-equal',
                format: 'depth24plus',
            },
        });

        this.backgroundUniformBuffer = this.device.createBuffer({
            // inverseViewProj (64) + eye (12) + exposure (4) + tonemap mode (4),
            // padded to the 16-byte uniform rule.
            size: 96,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Line-list pipeline for sewing bond overlays in the drape sim
        this.linePipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.vertexShader,
                entryPoint: 'main',
                buffers: [
                    {
                        arrayStride: 12,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' },
                        ],
                    },
                    {
                        arrayStride: 12,
                        attributes: [
                            { shaderLocation: 1, offset: 0, format: 'float32x3' },
                        ],
                    },
                ],
            },
            fragment: {
                module: this.fragmentShader,
                entryPoint: 'main',
                targets: [{ format: this.format }],
            },
            primitive: {
                topology: 'line-list',
                cullMode: 'none',
            },
            depthStencil: {
                depthWriteEnabled: false,
                depthCompare: 'less',
                format: 'depth24plus',
            },
        });

        // Alpha-blended flat quads for the quadrant snap grid.
        const gridVertexShader = this.device.createShaderModule({ code: gridVertexShaderCode });
        const gridFragmentShader = this.device.createShaderModule({ code: gridFragmentShaderCode });
        this.gridPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: gridVertexShader,
                entryPoint: 'main',
                buffers: [
                    {
                        arrayStride: 12,
                        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
                    },
                ],
            },
            fragment: {
                module: gridFragmentShader,
                entryPoint: 'main',
                targets: [
                    {
                        format: this.format,
                        blend: {
                            color: {
                                srcFactor: 'src-alpha',
                                dstFactor: 'one-minus-src-alpha',
                                operation: 'add',
                            },
                            // Keep the canvas opaque (clear alpha is 1).
                            alpha: {
                                srcFactor: 'one',
                                dstFactor: 'one-minus-src-alpha',
                                operation: 'add',
                            },
                        },
                    },
                ],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                depthWriteEnabled: false,
                depthCompare: 'less-equal',
                format: 'depth24plus',
            },
        });
        this.gridBindGroup = this.device.createBindGroup({
            layout: this.gridPipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: this.gridUniformBuffer! } }],
        });
    }

    /** Set (or clear) the flat quad overlay drawn with the scene. */
    setGridOverlay(overlay: QuadOverlay | null): void {
        this.gridOverlay = overlay;
        if (!overlay) {
            this.gridCellVertexCount = 0;
            this.gridHighlightVertexCount = 0;
            return;
        }
        this.gridCellBuffer = this.writeOverlayBuffer(
            this.gridCellBuffer,
            overlay.cells
        );
        this.gridCellVertexCount = Math.floor(overlay.cells.length / 3);
        if (overlay.highlight && overlay.highlight.length > 0) {
            this.gridHighlightBuffer = this.writeOverlayBuffer(
                this.gridHighlightBuffer,
                overlay.highlight
            );
            this.gridHighlightVertexCount = Math.floor(overlay.highlight.length / 3);
        } else {
            this.gridHighlightVertexCount = 0;
        }
    }

    /** Reuse a vertex buffer when it is large enough, otherwise reallocate. */
    private writeOverlayBuffer(current: GPUBuffer | null, data: Float32Array): GPUBuffer {
        let buffer = current;
        if (!buffer || buffer.size < data.byteLength) {
            buffer?.destroy();
            buffer = this.device.createBuffer({
                size: Math.max(data.byteLength, 12),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                label: 'grid-overlay',
            });
        }
        // Copy into an ArrayBuffer-backed view so the typings accept it as
        // GPUAllowSharedBufferSource (matches XpbdGpuEngine.gpuData).
        const bytes = new Uint8Array(data.byteLength);
        bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        this.device.queue.writeBuffer(buffer, 0, bytes);
        return buffer;
    }

    private drawGridOverlay(
        pass: GPURenderPassEncoder,
        viewProj: mat4,
        buffer: GPUBuffer | null,
        vertexCount: number,
        color: [number, number, number, number]
    ): void {
        if (!buffer || vertexCount <= 0 || !this.gridPipeline || !this.gridUniformBuffer) return;
        const data = new Float32Array(20);
        data.set(mat4ToArray(viewProj), 0);
        data.set(color, 16);
        this.device.queue.writeBuffer(this.gridUniformBuffer, 0, data);
        pass.setPipeline(this.gridPipeline);
        if (this.gridBindGroup) pass.setBindGroup(0, this.gridBindGroup);
        pass.setVertexBuffer(0, buffer);
        pass.draw(vertexCount);
    }

    resize(width: number, height: number): void {
        this.canvas.width = width;
        this.canvas.height = height;

        // Recreate depth texture
        this.depthTexture.destroy();
        this.depthTexture = this.device.createTexture({
            size: [width, height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthTextureView = this.depthTexture.createView();
    }

    setLight1Color(r: number, g: number, b: number): void {
        this.light1Color = [r, g, b];
    }

    setLight1Position(x: number, y: number, z: number): void {
        this.light1Position = [x, y, z];
    }

    setLight2Color(r: number, g: number, b: number): void {
        this.light2Color = [r, g, b];
    }

    setLight2Position(x: number, y: number, z: number): void {
        this.light2Position = [x, y, z];
    }

    setClothColor(r: number, g: number, b: number): void {
        this.clothColor = [r, g, b];
    }

    setGroundColor(r: number, g: number, b: number): void {
        this.groundColor = [r, g, b];
    }

    setWireframeMode(enabled: boolean): void {
        this.wireframeMode = enabled;
    }

    getWireframeMode(): boolean {
        return this.wireframeMode;
    }

    /** Wireframe / simple / PBR. */
    setShadingMode(mode: ShadingMode): void {
        if (mode === this.shading) return;
        this.shading = mode;
        // The bind groups do not change with the mode, but a mode change does
        // change which of them are used; dropping the cache keeps it honest.
        this.backgroundBindGroupCache = null;
    }

    getShadingMode(): ShadingMode {
        return this.shading;
    }

    shadingLabel(): string {
        return shadingModeLabel(this.shading);
    }

    /**
     * Share the app's environment (the HDRI maps). A viewport without one simply
     * has no background and no light probe.
     */
    attachEnvironment(environment: Environment): void {
        if (this.environment === environment) return;
        this.environmentUnsubscribe?.();
        this.environment = environment;
        this.environmentUnsubscribe = environment.onChange(() => {
            // The environment rebuilt its textures: every bind group that
            // referenced them is stale.
            this.pbrEnvBindGroups = new WeakMap();
            this.backgroundBindGroupCache = null;
        });
    }

    /** Cloth surface roughness in PBR mode (0.05 mirror-ish .. 1 fully diffuse). */
    setSurfaceRoughness(roughness: number): void {
        this.surfaceRoughness = Math.min(1, Math.max(0.05, roughness));
    }

    /**
     * Share the studio's material library. Materials only change uniform values,
     * which are rewritten every frame, so there is nothing cached to drop.
     */
    attachMaterials(materials: MaterialLibrary): void {
        this.materials = materials;
    }

    /** Share the studio's fabric library; texture entries are created on demand. */
    attachFabrics(fabrics: FabricLibrary): void {
        this.fabrics = fabrics;
    }

    /** Which fabric variant each piece is made of, by piece id. */
    setFabricAssignments(assignments: ReadonlyMap<string, string>): void {
        if (assignments.size === this.fabricAssignments.size) {
            let same = true;
            for (const [pieceId, fabricId] of assignments) {
                if (this.fabricAssignments.get(pieceId) !== fabricId) {
                    same = false;
                    break;
                }
            }
            if (same) return;
        }
        this.fabricAssignments = new Map(assignments);
        this.clothLightingGroups = new WeakMap();
    }

    /** Whether a cloth albedo image is actually uploaded and sampling. */
    private writeAlbedoOptions(): void {
        if (!this.albedoOptionsBuffer) return;
        const useTexture = this.albedoTextureView ? 1 : 0;
        this.device.queue.writeBuffer(
            this.albedoOptionsBuffer,
            0,
            new Float32Array([useTexture, 0, 0, 0])
        );
    }

    /**
     * Follow the cloth material's image. Called once per cloth draw: a change of
     * URL starts a decode and keeps the current texture bound until it lands, so
     * switching images never flashes the solid colour.
     */
    private syncAlbedoTexture(): void {
        const url = this.materials?.get('cloth').albedoImage ?? null;
        if (url === this.albedoTextureUrl) return;
        if (url && url === this.albedoTextureLoading) return;
        this.albedoTextureUrl = url;
        if (!url) {
            this.albedoTexture?.destroy();
            this.albedoTexture = null;
            this.albedoTextureView = null;
            this.albedoBindGroups = new WeakMap();
            this.writeAlbedoOptions();
            return;
        }
        this.albedoTextureLoading = url;
        void this.loadAlbedoTexture(url);
    }

    private async loadAlbedoTexture(url: string): Promise<void> {
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            let bitmap = await createImageBitmap(blob);
            const max = this.device.limits.maxTextureDimension2D;
            if (bitmap.width > max || bitmap.height > max) {
                const scale = max / Math.max(bitmap.width, bitmap.height);
                const resized = await createImageBitmap(blob, {
                    resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
                    resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
                    resizeQuality: 'high',
                });
                bitmap.close();
                bitmap = resized;
            }
            // Another image was chosen while this one decoded.
            if (this.albedoTextureUrl !== url) {
                bitmap.close();
                return;
            }
            const texture = this.device.createTexture({
                size: [bitmap.width, bitmap.height, 1],
                format: 'rgba8unorm-srgb',
                usage:
                    GPUTextureUsage.TEXTURE_BINDING |
                    GPUTextureUsage.COPY_DST |
                    GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this.device.queue.copyExternalImageToTexture(
                { source: bitmap },
                { texture },
                [bitmap.width, bitmap.height]
            );
            bitmap.close();
            this.albedoTexture?.destroy();
            this.albedoTexture = texture;
            this.albedoTextureView = texture.createView();
            this.albedoBindGroups = new WeakMap();
            this.writeAlbedoOptions();
        } catch (error) {
            // Keep the URL recorded so a broken image is not fetched every frame;
            // whatever texture was already bound stays bound.
            console.warn('Could not load the cloth albedo image', error);
            this.writeAlbedoOptions();
        } finally {
            if (this.albedoTextureLoading === url) this.albedoTextureLoading = null;
        }
    }

    /**
     * Follow every fabric variant's image. Entries are kept per variant so a
     * piece made of wool never sees the silk texture, and a variant whose image
     * was cleared falls back to its colour.
     */
    private syncFabricTextures(): void {
        const fabrics = this.fabrics;
        if (!fabrics) return;
        const live = new Set(fabrics.variants.map((variant) => variant.id));
        for (const id of [...this.fabricTextures.keys()]) {
            if (!live.has(id)) {
                const entry = this.fabricTextures.get(id);
                entry?.texture?.destroy();
                this.fabricTextures.delete(id);
            }
        }
        for (const variant of fabrics.variants) this.ensureFabricTexture(variant);
    }

    private ensureFabricTexture(variant: {
        id: string;
        albedoImage?: string;
    }): {
        url: string | null;
        loading: string | null;
        texture: GPUTexture | null;
        view: GPUTextureView | null;
        options: GPUBuffer;
        groups: WeakMap<GPURenderPipeline, GPUBindGroup>;
    } {
        let entry = this.fabricTextures.get(variant.id);
        if (!entry) {
            const options = this.device.createBuffer({
                size: 16,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(options, 0, new Float32Array([0, 0, 0, 0]));
            entry = {
                url: null,
                loading: null,
                texture: null,
                view: null,
                options,
                groups: new WeakMap(),
            };
            this.fabricTextures.set(variant.id, entry);
        }
        const url = variant.albedoImage ?? null;
        if (url !== entry.url) {
            entry.url = url;
            entry.loading = null;
            entry.texture?.destroy();
            entry.texture = null;
            entry.view = null;
            entry.groups = new WeakMap();
            this.device.queue.writeBuffer(entry.options, 0, new Float32Array([0, 0, 0, 0]));
            if (url) {
                entry.loading = url;
                void this.loadFabricTexture(variant.id, url, entry);
            }
        }
        return entry;
    }

    private async loadFabricTexture(
        variantId: string,
        url: string,
        entry: {
            url: string | null;
            loading: string | null;
            texture: GPUTexture | null;
            view: GPUTextureView | null;
            options: GPUBuffer;
            groups: WeakMap<GPURenderPipeline, GPUBindGroup>;
        }
    ): Promise<void> {
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            let bitmap = await createImageBitmap(blob);
            const max = this.device.limits.maxTextureDimension2D;
            if (bitmap.width > max || bitmap.height > max) {
                const scale = max / Math.max(bitmap.width, bitmap.height);
                const resized = await createImageBitmap(blob, {
                    resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
                    resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
                    resizeQuality: 'high',
                });
                bitmap.close();
                bitmap = resized;
            }
            if (entry.url !== url || this.fabricTextures.get(variantId) !== entry) {
                bitmap.close();
                return;
            }
            const texture = this.device.createTexture({
                size: [bitmap.width, bitmap.height, 1],
                format: 'rgba8unorm-srgb',
                usage:
                    GPUTextureUsage.TEXTURE_BINDING |
                    GPUTextureUsage.COPY_DST |
                    GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this.device.queue.copyExternalImageToTexture(
                { source: bitmap },
                { texture },
                [bitmap.width, bitmap.height]
            );
            bitmap.close();
            entry.texture = texture;
            entry.view = texture.createView();
            entry.groups = new WeakMap();
            this.device.queue.writeBuffer(entry.options, 0, new Float32Array([1, 0, 0, 0]));
        } catch (error) {
            console.warn('Could not load a fabric image', error);
        } finally {
            if (entry.loading === url) entry.loading = null;
        }
    }

    /** Group 2 for a fabric variant on a given cloth pipeline. */
    private fabricAlbedoBindGroup(
        pipeline: GPURenderPipeline,
        variantId: string
    ): GPUBindGroup | null {
        const variant = this.fabrics?.variantById(variantId);
        if (!variant || !this.albedoSampler) return null;
        const entry = this.ensureFabricTexture(variant);
        const cached = entry.groups.get(pipeline);
        if (cached) return cached;
        const view = entry.view ?? this.defaultAlbedoView;
        if (!view) return null;
        const group = this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(2),
            entries: [
                { binding: 0, resource: this.albedoSampler },
                { binding: 1, resource: view },
                { binding: 2, resource: { buffer: entry.options } },
            ],
        });
        entry.groups.set(pipeline, group);
        return group;
    }

    /** Group 2 for a cloth pipeline: sampler, image, and the use-image flag. */
    private albedoBindGroup(pipeline: GPURenderPipeline): GPUBindGroup | null {
        const cached = this.albedoBindGroups.get(pipeline);
        if (cached) return cached;
        const view = this.albedoTextureView ?? this.defaultAlbedoView;
        if (!this.albedoSampler || !this.albedoOptionsBuffer || !view) return null;
        const group = this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(2),
            entries: [
                { binding: 0, resource: this.albedoSampler },
                { binding: 1, resource: view },
                { binding: 2, resource: { buffer: this.albedoOptionsBuffer } },
            ],
        });
        this.albedoBindGroups.set(pipeline, group);
        return group;
    }

    /**
     * Contiguous index runs, one per piece. The topology builds each piece's
     * triangles together, so a run is everything that piece draws — and a piece
     * can therefore carry its own fabric inside a single cloth draw.
     */
    private clothRuns(cloth: RenderableCloth): Array<{
        pieceId: string;
        first: number;
        count: number;
    }> {
        const simulator = cloth as ClothSimulator;
        const indexBuffer = simulator.getIndexBuffer?.() ?? null;
        const cached = indexBuffer ? this.clothRunsCache.get(indexBuffer) : undefined;
        if (cached) return cached;
        const ids = simulator.getVertexPieceIds?.();
        const triangles = simulator.getTriangleIndices?.();
        if (!ids || !triangles || triangles.length < 3) return [];
        const runs: Array<{ pieceId: string; first: number; count: number }> = [];
        let current: { pieceId: string; first: number; count: number } | null = null;
        for (let first = 0; first + 2 < triangles.length; first += 3) {
            const pieceId = ids[triangles[first]!] ?? '';
            if (current && current.pieceId === pieceId) {
                current.count += 3;
            } else {
                current = { pieceId, first, count: 3 };
                runs.push(current);
            }
        }
        if (indexBuffer) this.clothRunsCache.set(indexBuffer, runs);
        return runs;
    }

    /**
     * The material a piece is made of: its fabric variant when it has one, and
     * the cloth material otherwise.
     */
    private pieceMaterial(pieceId: string): { material: MaterialParams; variantId: string | null } {
        const variantId = this.fabricAssignments.get(pieceId) ?? null;
        const variant = this.fabrics?.variantById(variantId) ?? null;
        if (variant) return { material: materialForVariant(variant), variantId: variant.id };
        return { material: this.clothMaterial(), variantId: null };
    }

    /** Write one material block per draw run, past the shared base block. */
    private writeClothLightingBlocks(
        base: Float32Array<ArrayBuffer>,
        runs: ReadonlyArray<{ pieceId: string }>
    ): void {
        const blocks = runs.length + 1;
        if (this.clothLightingBytes < blocks * 256) {
            this.clothLightingBytes = blocks * 256;
            this.lightingBuffer?.destroy();
            this.lightingBuffer = this.device.createBuffer({
                size: this.clothLightingBytes,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.clothLightingGroups = new WeakMap();
        }
        const buffer = this.lightingBuffer!;
        this.device.queue.writeBuffer(buffer, 0, base);
        runs.forEach((run, index) => {
            const block = new Float32Array(base);
            const { material } = this.pieceMaterial(run.pieceId);
            block[20] = material.color[0];
            block[21] = material.color[1];
            block[22] = material.color[2];
            block[27] = material.roughness;
            block[29] = material.metallic;
            this.device.queue.writeBuffer(buffer, (index + 1) * 256, block);
        });
    }

    /** Group 0 for a cloth pipeline at one material block. */
    private clothBindGroupAt(
        pipeline: GPURenderPipeline,
        offset: number
    ): GPUBindGroup {
        if (offset === 0) {
            return this.createBindGroup(pipeline, this.uniformBuffer!, this.lightingBuffer!);
        }
        let byOffset = this.clothLightingGroups.get(pipeline);
        const cached = byOffset?.get(offset);
        if (cached) return cached;
        const group = this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer! } },
                {
                    binding: 1,
                    resource: {
                        buffer: this.lightingBuffer!,
                        offset,
                        size: 256,
                    },
                },
            ],
        });
        if (!byOffset) {
            byOffset = new Map();
            this.clothLightingGroups.set(pipeline, byOffset);
        }
        byOffset.set(offset, group);
        return group;
    }

    /** The material a surface is shaded with, falling back to the demo's colours. */
    private clothMaterial(): MaterialParams {
        return (
            this.materials?.forPiece() ?? {
                color: [...this.clothColor] as [number, number, number],
                roughness: this.surfaceRoughness,
                metallic: 0,
            }
        );
    }

    private referenceMaterial(): MaterialParams {
        return (
            this.materials?.get('reference') ?? {
                color: [...this.groundColor] as [number, number, number],
                roughness: this.surfaceRoughness,
                metallic: 0,
            }
        );
    }

    /** The pedestal is always the reference colour, 25% darker. */
    private pedestalMaterial(): MaterialParams {
        const reference = this.referenceMaterial();
        const own = this.materials?.pedestal();
        return {
            color: own?.color ?? reference.color.map((c) => c * PEDESTAL_DARKENING) as [number, number, number],
            roughness: own?.roughness ?? reference.roughness,
            metallic: own?.metallic ?? reference.metallic,
        };
    }

    /** Write a surface's albedo / roughness / metallic into a lighting buffer. */
    private writeMaterial(target: Float32Array, material: MaterialParams): void {
        target[20] = material.color[0];
        target[21] = material.color[1];
        target[22] = material.color[2];
        target[27] = material.roughness;
        target[29] = material.metallic;
    }

    setExposure(exposure: number): void {
        this.exposure = Math.max(0.05, Math.min(8, exposure));
    }

    private wantsBackground(): boolean {
        // Only PBR shows the environment: `simple` keeps the flat studio look it
        // has always had, and wires read better against nothing.
        return (
            this.shading === 'pbr' &&
            !!this.environment?.drawBackground &&
            this.backgroundUniformBuffer !== null
        );
    }

    private pbrEnvBindGroup(pipeline: GPURenderPipeline): GPUBindGroup | null {
        const cached = this.pbrEnvBindGroups.get(pipeline);
        if (cached) return cached;
        if (!this.environment) return null;
        const group = this.environment.textureBindGroup(pipeline.getBindGroupLayout(1));
        if (!group) return null;
        this.pbrEnvBindGroups.set(pipeline, group);
        return group;
    }

    /**
     * PBR floor: a white cylinder of the floor's own radius, 12 inches tall, with
     * its top cap at the floor plane so the avatar still stands on it.
     */
    private drawFloorCylinder(
        pass: GPURenderPassEncoder,
        floor: ClothFloor,
        viewProj: mat4,
        lightingData: Float32Array
    ): void {
        const radius = floor.getGradientHalfExtent?.() ?? 0;
        if (!(radius > 0)) return;
        this.ensureCylinder(radius);

        const cylinder = this.cylinder;
        const pipeline = this.pbrPipeline;
        if (!cylinder || !pipeline || !this.floorUniformBuffer || !this.floorLightingBuffer) {
            return;
        }
        const envBindGroup = this.pbrEnvBindGroup(pipeline);
        if (!envBindGroup) return;

        // The floor plane is built centred on the origin, so its matrix — a plain
        // translate to the floor height — is also the pedestal's matrix.
        const uniformData = new Float32Array(32);
        uniformData.set(mat4ToArray(viewProj), 0);
        uniformData.set(mat4ToArray(floor.getModelMatrix()), 16);
        this.device.queue.writeBuffer(this.floorUniformBuffer, 0, uniformData);

        // The pedestal is the reference material, 25% darker.
        const lighting = Float32Array.from(lightingData);
        this.writeMaterial(lighting, this.pedestalMaterial());
        this.device.queue.writeBuffer(this.floorLightingBuffer, 0, lighting);

        pass.setPipeline(pipeline);
        pass.setBindGroup(
            0,
            this.createBindGroup(pipeline, this.floorUniformBuffer, this.floorLightingBuffer)
        );
        pass.setBindGroup(1, envBindGroup);
        pass.setVertexBuffer(0, cylinder.positionBuffer);
        pass.setVertexBuffer(1, cylinder.normalBuffer);
        pass.setIndexBuffer(cylinder.indexBuffer, 'uint32');
        pass.drawIndexed(cylinder.indexCount);
    }

    /** Build (or rebuild) the pedestal for a floor radius; it never deforms. */
    private ensureCylinder(radius: number): void {
        if (this.cylinder && Math.abs(this.cylinder.radius - radius) < 1e-4) return;
        this.cylinder?.positionBuffer.destroy();
        this.cylinder?.normalBuffer.destroy();
        this.cylinder?.indexBuffer.destroy();

        const geometry = cylinderGeometry(radius, CYLINDER_HEIGHT_WORLD);
        const device = this.device;
        const positionBuffer = device.createBuffer({
            size: geometry.positions.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
            label: 'floor-cylinder-positions',
        });
        new Float32Array(positionBuffer.getMappedRange()).set(geometry.positions);
        positionBuffer.unmap();
        const normalBuffer = device.createBuffer({
            size: geometry.normals.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
            label: 'floor-cylinder-normals',
        });
        new Float32Array(normalBuffer.getMappedRange()).set(geometry.normals);
        normalBuffer.unmap();
        const indexBuffer = device.createBuffer({
            size: geometry.indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
            label: 'floor-cylinder-indices',
        });
        new Uint32Array(indexBuffer.getMappedRange()).set(geometry.indices);
        indexBuffer.unmap();

        this.cylinder = {
            radius,
            positionBuffer,
            normalBuffer,
            indexBuffer,
            indexCount: geometry.indices.length,
        };
    }

    /** The HDRI, drawn first: each pixel unprojects to a direction and samples it. */
    private drawBackground(pass: GPURenderPassEncoder, viewProj: mat4, eye: vec3): void {
        const environment = this.environment;
        if (!environment || !this.backgroundUniformBuffer) return;
        const pipeline = environment.backgroundPipeline;

        const inverse = mat4.create();
        mat4.invert(inverse, viewProj);
        const uniforms = new Float32Array(24);
        uniforms.set(mat4ToArray(inverse), 0);
        // The ray runs from the eye to the unprojected far point.
        uniforms[16] = eye[0];
        uniforms[17] = eye[1];
        uniforms[18] = eye[2];
        uniforms[19] = environment.exposure;
        // A float slot holding a small integer: exact, and one array to write.
        uniforms[20] = tonemapIndex(environment.tonemap);
        this.device.queue.writeBuffer(this.backgroundUniformBuffer, 0, uniforms);

        if (!this.backgroundBindGroupCache) {
            this.backgroundBindGroupCache = environment.backgroundBindGroup(
                pipeline.getBindGroupLayout(0),
                this.backgroundUniformBuffer
            );
        }
        if (!this.backgroundBindGroupCache) return;

        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.backgroundBindGroupCache);
        pass.draw(3);
    }

    render(cloth: RenderableCloth, camera: Camera): void {
        // A moved blur slider rebuilds the background's Gaussian before any
        // pass is encoded — the light probe itself is untouched.
        this.environment?.prepareBackground();
        const viewProj = camera.getViewProjectMtx();
        const model = cloth.getModelMatrix();

        // Update uniform buffer
        const uniformData = new Float32Array(32);
        uniformData.set(mat4ToArray(viewProj), 0);
        uniformData.set(mat4ToArray(model), 16);
        this.device.queue.writeBuffer(this.uniformBuffer!, 0, uniformData);

        // Normalize light directions
        const light1Len = Math.sqrt(
            this.light1Position[0] ** 2 + 
            this.light1Position[1] ** 2 + 
            this.light1Position[2] ** 2
        );
        const light2Len = Math.sqrt(
            this.light2Position[0] ** 2 + 
            this.light2Position[1] ** 2 + 
            this.light2Position[2] ** 2
        );

        // Update lighting buffer - prepare base lighting data
        // In WGSL, vec3 is aligned to 16 bytes (4 floats), so layout is:
        // ambientColor: offset 0 (indices 0-2, padding at 3)
        // lightDirection: offset 16 (indices 4-6, padding at 7)
        // lightColor: offset 32 (indices 8-10, padding at 11)
        // lightDirection2: offset 48 (indices 12-14, padding at 15)
        // lightColor2: offset 64 (indices 16-18, padding at 19)
        // diffuseColor: offset 80 (indices 20-22, padding at 23)
        const lightingData = new Float32Array(64); // 256 bytes / 4
        
        // Always use normal lighting for the cloth (same as when wireframe is off)
        // Wireframe will have its own special lighting settings when rendered
        lightingData[0] = 0.15;
        lightingData[1] = 0.15;
        lightingData[2] = 0.15;
        lightingData[3] = 0.0; // padding
        // Light 1 direction (normalized)
        lightingData[4] = light1Len > 0 ? this.light1Position[0] / light1Len : 0;
        lightingData[5] = light1Len > 0 ? this.light1Position[1] / light1Len : 0;
        lightingData[6] = light1Len > 0 ? this.light1Position[2] / light1Len : 0;
        lightingData[7] = 0.0; // padding
        // Light 1 color
        lightingData[8] = this.light1Color[0];
        lightingData[9] = this.light1Color[1];
        lightingData[10] = this.light1Color[2];
        lightingData[11] = 0.0; // padding
        // Light 2 direction (normalized)
        lightingData[12] = light2Len > 0 ? this.light2Position[0] / light2Len : 0;
        lightingData[13] = light2Len > 0 ? this.light2Position[1] / light2Len : 0;
        lightingData[14] = light2Len > 0 ? this.light2Position[2] / light2Len : 0;
        lightingData[15] = 0.0; // padding
        // Light 2 color
        lightingData[16] = this.light2Color[0];
        lightingData[17] = this.light2Color[1];
        lightingData[18] = this.light2Color[2];
        lightingData[19] = 0.0; // padding
        // Diffuse color (cloth material); [23] = useVertexColor for strain map
        const clothMaterial = this.clothMaterial();
        lightingData[20] = clothMaterial.color[0];
        lightingData[21] = clothMaterial.color[1];
        lightingData[22] = clothMaterial.color[2];
        const colorBuffer =
            'getColorBuffer' in cloth && typeof (cloth as ClothSimulator).getColorBuffer === 'function'
                ? (cloth as ClothSimulator).getColorBuffer?.() ?? null
                : null;
        const uvBuffer =
            'getUvBuffer' in cloth && typeof (cloth as ClothSimulator).getUvBuffer === 'function'
                ? (cloth as ClothSimulator).getUvBuffer?.() ?? null
                : null;
        // The colored pipelines declare both vertex buffers; a cloth without
        // them (the demo's own) keeps the plain pipeline.
        const colorReady = !!colorBuffer && !!uvBuffer;
        const useVertexColor =
            colorReady &&
            'isStrainMapEnabled' in cloth &&
            typeof (cloth as ClothSimulator).isStrainMapEnabled === 'function' &&
            !!(cloth as ClothSimulator).isStrainMapEnabled?.();
        lightingData[23] = useVertexColor ? 1.0 : 0.0;
        // A frozen or ghosted piece dims its own vertices. The dimmed fragments
        // are drawn by a second, blended pass over the same vertices, so the
        // cloth is drawn twice and each pass keeps only its half of the pieces.
        const alphaCloth = 'hasTranslucentPieces' in cloth ? (cloth as ClothSimulator) : null;
        const alphaBuffer =
            colorReady && alphaCloth?.hasTranslucentPieces?.()
                ? alphaCloth.getAlphaBuffer?.() ?? null
                : null;
        // PBR-only tail of the same buffer: view vector, roughness, exposure,
        // metallic, tone mapping operator.
        const eye = camera.getEyePosition();
        lightingData[24] = eye[0];
        lightingData[25] = eye[1];
        lightingData[26] = eye[2];
        lightingData[27] = clothMaterial.roughness;
        // The shared exposure control wins while an environment is attached, so
        // the fabric and the HDRI behind it stay on the same stop.
        lightingData[28] = this.environment?.exposure ?? this.exposure;
        lightingData[29] = clothMaterial.metallic;
        lightingData[30] = tonemapIndex(this.environment?.tonemap);

        // One material block per piece that has its own fabric, after the
        // shared base block. With no fabric assignments this is the old single
        // write and the old single draw.
        const clothRuns =
            this.fabrics && this.fabricAssignments.size > 0 ? this.clothRuns(cloth) : [];
        if (clothRuns.length > 0) {
            this.writeClothLightingBlocks(lightingData, clothRuns);
        } else {
            this.device.queue.writeBuffer(this.lightingBuffer!, 0, lightingData);
        }

        // Follow the material's images before any bind group is asked for one.
        this.syncAlbedoTexture();
        this.syncFabricTextures();

        // Get current texture from canvas
        const texture = this.context.getCurrentTexture();
        const textureView = texture.createView();

        // Create command encoder AFTER buffer write
        // In WebGPU, queue operations are ordered, so writes complete before commands execute
        const encoder = this.device.createCommandEncoder();
        
        // IMPORTANT: Create bind group AFTER buffer write to ensure it references updated buffer
        // Note: Bind groups just reference the buffer, they don't cache data
        const pbrPipeline = alphaBuffer
            ? this.pbrClothAlphaPipeline!
            : colorReady && this.pbrClothPipeline
              ? this.pbrClothPipeline
              : this.pbrPipeline;
        // PBR needs the environment's textures bound: while the HDRI is still
        // building (or absent) the frame keeps the simple shader.
        const clothEnvBindGroup =
            this.shading === 'pbr' && pbrPipeline && this.environment?.ready
                ? this.pbrEnvBindGroup(pbrPipeline)
                : null;
        /** PBR is on and the environment is built: scene objects light with it. */
        const pbrAvailable = clothEnvBindGroup !== null;
        const clothPipeline = clothEnvBindGroup
            ? pbrPipeline!
            : alphaBuffer
              ? this.clothAlphaPipeline!
              : colorReady && this.clothPipeline
                ? this.clothPipeline
                : this.renderPipeline!;
        const clothBindGroup = this.createBindGroup(
            clothPipeline,
            this.uniformBuffer!,
            this.lightingBuffer!
        );
        const clothBlendPipeline = alphaBuffer
            ? clothEnvBindGroup
                ? this.pbrClothAlphaBlendPipeline
                : this.clothAlphaBlendPipeline
            : null;
        // The blended pass runs on its own pipelines, so it gets its own bind
        // groups rather than relying on layout equivalence between them.
        const clothBlendBindGroup = clothBlendPipeline
            ? this.createBindGroup(clothBlendPipeline, this.uniformBuffer!, this.lightingBuffer!)
            : null;
        const blendEnvBindGroup =
            clothBlendPipeline && clothEnvBindGroup
                ? this.pbrEnvBindGroup(clothBlendPipeline)
                : null;
        
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: textureView,
                    clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        // The HDRI goes down first: it needs no depth against anything, and the
        // scene then draws over it normally.
        if (this.wantsBackground()) {
            this.drawBackground(pass, viewProj, eye);
        }

        // Render cloth - check if buffers are valid
        const positionBuffer = cloth.getPositionBuffer();
        const normalBuffer = cloth.getNormalBuffer();
        const indexBuffer = cloth.getIndexBuffer();
        
        if (!positionBuffer || !normalBuffer || !indexBuffer) {
            console.warn('Cloth buffers not ready, skipping render');
            pass.end();
            this.device.queue.submit([encoder.finish()]);
            return;
        }

        // Wireframe mode draws the mesh edges only: seeing through the fabric is
        // the whole point of the mode.
        const drawFill = this.shading !== 'wireframe';
        /**
         * The dimmed half of the cloth draws last, over everything else: it does
         * not write depth, so anything drawn after it would cover it up. Filled
         * in below, once the cloth bind groups exist.
         */
        let drawTranslucentCloth: (() => void) | null = null;
        if (drawFill) {
            const usesVertexColor =
                clothPipeline === this.clothPipeline ||
                clothPipeline === this.pbrClothPipeline ||
                clothPipeline === this.clothAlphaPipeline ||
                clothPipeline === this.pbrClothAlphaPipeline;
            // The UV buffer comes after color and, when present, alpha.
            const uvSlot = alphaBuffer ? 4 : 3;
            const clothAlbedoBindGroup = usesVertexColor
                ? this.albedoBindGroup(clothPipeline)
                : null;
            const bindClothBuffers = (bindGroup: GPUBindGroup) => {
                pass.setBindGroup(0, bindGroup);
                pass.setVertexBuffer(0, positionBuffer);
                pass.setVertexBuffer(1, normalBuffer);
                if (colorBuffer && usesVertexColor) pass.setVertexBuffer(2, colorBuffer);
                if (alphaBuffer) pass.setVertexBuffer(3, alphaBuffer);
                if (uvBuffer && usesVertexColor) pass.setVertexBuffer(uvSlot, uvBuffer);
                pass.setIndexBuffer(indexBuffer, cloth.getIndexFormat());
            };
            if (clothEnvBindGroup) pass.setBindGroup(1, clothEnvBindGroup);
            pass.setPipeline(clothPipeline);
            const drawRanges = (
                pipeline: GPURenderPipeline,
                translucent: boolean
            ): void => {
                if (clothRuns.length === 0) {
                    const group = this.clothBindGroupAt(pipeline, 0);
                    const albedo = this.albedoBindGroup(pipeline);
                    if (albedo) pass.setBindGroup(2, albedo);
                    bindClothBuffers(group);
                    pass.drawIndexed(cloth.getIndexCount());
                    return;
                }
                clothRuns.forEach((run, index) => {
                    const group = this.clothBindGroupAt(pipeline, (index + 1) * 256);
                    const { variantId } = this.pieceMaterial(run.pieceId);
                    const albedo =
                        (variantId && this.fabricAlbedoBindGroup(pipeline, variantId)) ||
                        this.albedoBindGroup(pipeline);
                    if (albedo) pass.setBindGroup(2, albedo);
                    bindClothBuffers(group);
                    pass.drawIndexed(run.count, 1, run.first);
                });
                void translucent;
            };
            drawRanges(clothPipeline, false);

            if (clothBlendPipeline && clothBlendBindGroup) {
                const blendPipeline = clothBlendPipeline;
                // Second pass over the same vertices: the opaque half discards
                // here, the dimmed half blends over the finished scene.
                drawTranslucentCloth = () => {
                    if (blendEnvBindGroup) pass.setBindGroup(1, blendEnvBindGroup);
                    pass.setPipeline(blendPipeline);
                    drawRanges(blendPipeline, true);
                };
            }
        }

        // The wireframe overlay: either the debug overlay the demo page asks for,
        // or the whole point of the wireframe shading mode.
        if ((this.wireframeMode || this.shading === 'wireframe') && this.wireframePipeline) {
            const wireframeBuffers = cloth.getWireframeBuffers();
            const wireframeEdges = wireframeBuffers
                ? null
                : (cloth as ClothSimulator).getWireframeEdges?.() ?? null;
            if (
                (wireframeBuffers && wireframeBuffers.indexCount > 0) ||
                (wireframeEdges && wireframeEdges.indexCount > 0)
            ) {
                // Create wireframe lighting data with bright cyan color
                const wireframeLightingData = new Float32Array(64);
                wireframeLightingData.set(lightingData);
                // Set diffuse color to bright cyan for wireframe
                wireframeLightingData[20] = this.wireframeColor[0];
                wireframeLightingData[21] = this.wireframeColor[1];
                wireframeLightingData[22] = this.wireframeColor[2];
                // Make ambient VERY high so wireframe is always bright and visible
                wireframeLightingData[0] = 2.0; // Overbright for maximum visibility
                wireframeLightingData[1] = 2.0;
                wireframeLightingData[2] = 2.0;
                // Disable directional lights for wireframe (make it pure bright cyan)
                wireframeLightingData[8] = 0.0;
                wireframeLightingData[9] = 0.0;
                wireframeLightingData[10] = 0.0;
                wireframeLightingData[16] = 0.0;
                wireframeLightingData[17] = 0.0;
                wireframeLightingData[18] = 0.0;
                // Dedicated buffers: the seam overlay writes its own lighting
                // later in this same pass, and both land before the submit.
                this.device.queue.writeBuffer(this.wireframeUniformBuffer!, 0, uniformData);
                this.device.queue.writeBuffer(this.wireframeLightingBuffer!, 0, wireframeLightingData);

                if (wireframeBuffers && wireframeBuffers.indexCount > 0) {
                    // Render wireframe quads (triangles) on top
                    pass.setPipeline(this.wireframePipeline);
                    pass.setBindGroup(
                        0,
                        this.createBindGroup(
                            this.wireframePipeline,
                            this.wireframeUniformBuffer!,
                            this.wireframeLightingBuffer!
                        )
                    );
                    pass.setVertexBuffer(0, wireframeBuffers.positionBuffer);
                    pass.setVertexBuffer(1, wireframeBuffers.normalBuffer);
                    pass.setIndexBuffer(wireframeBuffers.indexBuffer, wireframeBuffers.indexFormat);
                    pass.drawIndexed(wireframeBuffers.indexCount);
                } else if (wireframeEdges && this.linePipeline) {
                    // Drape engines have no ribbon geometry: draw the mesh edges
                    // straight from their vertex buffers as a line list.
                    pass.setPipeline(this.linePipeline);
                    pass.setBindGroup(
                        0,
                        this.createBindGroup(
                            this.linePipeline,
                            this.wireframeUniformBuffer!,
                            this.wireframeLightingBuffer!
                        )
                    );
                    pass.setVertexBuffer(0, positionBuffer);
                    pass.setVertexBuffer(1, normalBuffer);
                    pass.setIndexBuffer(wireframeEdges.indexBuffer, wireframeEdges.indexFormat);
                    pass.drawIndexed(wireframeEdges.indexCount);
                }
            } else {
                // Fallback: disable wireframe if buffers not available
                console.warn('Wireframe buffers not available, disabling wireframe mode');
                this.wireframeMode = false;
                const wireframeToggle = document.getElementById('wireframeToggle') as HTMLInputElement;
                if (wireframeToggle) wireframeToggle.checked = false;
            }
        }

        // Wireframe mode shows the mesh against empty space: a lit sphere and a
        // floor under the wires only compete with them. The overlays further down
        // (seam lines, quadrant grid) still draw, so the tools keep working.
        const showScene = this.shading !== 'wireframe';

        // Render ground (sphere) — dedicated object buffers so cloth stays correctly lit
        const ground = showScene ? cloth.getGround() : null;
        if (ground) {
            const groundModel = ground.getModelMatrix();
            const groundUniformData = new Float32Array(32);
            groundUniformData.set(mat4ToArray(viewProj), 0);
            groundUniformData.set(mat4ToArray(groundModel), 16);
            this.device.queue.writeBuffer(this.objectUniformBuffer!, 0, groundUniformData);

            const groundLightingData = new Float32Array(64);
            groundLightingData.set(lightingData);
            this.writeMaterial(groundLightingData, this.referenceMaterial());
            this.device.queue.writeBuffer(this.objectLightingBuffer!, 0, groundLightingData);

            // The collision reference (sphere collider or avatar) is part of the
            // scene, so PBR mode lights it with the same environment.
            const objectEnv = pbrAvailable ? this.pbrEnvBindGroup(this.pbrPipeline!) : null;
            const objectPipeline = objectEnv ? this.pbrPipeline! : this.renderPipeline!;
            const objectBindGroup = this.createBindGroup(
                objectPipeline,
                this.objectUniformBuffer!,
                this.objectLightingBuffer!
            );
            pass.setPipeline(objectPipeline);
            pass.setBindGroup(0, objectBindGroup);
            if (objectEnv) pass.setBindGroup(1, objectEnv);
            pass.setVertexBuffer(0, ground.getPositionBuffer());
            pass.setVertexBuffer(1, ground.getNormalBuffer());
            pass.setIndexBuffer(ground.getIndexBuffer(), 'uint32');
            pass.drawIndexed(ground.getIndexCount());
        }

        // Optional flat floor under the avatar
        const floor =
          showScene && 'getFloor' in cloth && typeof cloth.getFloor === 'function'
            ? cloth.getFloor?.()
            : null;
        if (floor) {
          const floorModel = floor.getModelMatrix();

          if (pbrAvailable) {
            this.drawFloorCylinder(pass, floor, viewProj, lightingData);
          } else if (floor.usesRadialGradient?.() && this.floorPipeline) {
            const floorUniformData = new Float32Array(36);
            floorUniformData.set(mat4ToArray(viewProj), 0);
            floorUniformData.set(mat4ToArray(floorModel), 16);
            floorUniformData[32] = floor.getGradientHalfExtent?.() ?? 1;
            this.device.queue.writeBuffer(this.floorUniformBuffer!, 0, floorUniformData);

            pass.setPipeline(this.floorPipeline);
            pass.setBindGroup(0, this.createFloorBindGroup());
            pass.setVertexBuffer(0, floor.getPositionBuffer());
            pass.setVertexBuffer(1, floor.getNormalBuffer());
            pass.setIndexBuffer(floor.getIndexBuffer(), 'uint32');
            pass.drawIndexed(floor.getIndexCount());
          } else {
            const floorUniformData = new Float32Array(32);
            floorUniformData.set(mat4ToArray(viewProj), 0);
            floorUniformData.set(mat4ToArray(floorModel), 16);
            this.device.queue.writeBuffer(this.floorUniformBuffer!, 0, floorUniformData);

            const floorLightingData = new Float32Array(64);
            floorLightingData.set(lightingData);
            // The flat floor is the same material as the pedestal that replaces
            // it in PBR mode, just drawn as a plane.
            const flatFloor = this.pedestalMaterial();
            floorLightingData[20] = flatFloor.color[0];
            floorLightingData[21] = flatFloor.color[1];
            floorLightingData[22] = flatFloor.color[2];
            this.device.queue.writeBuffer(this.floorLightingBuffer!, 0, floorLightingData);

            pass.setPipeline(this.renderPipeline!);
            pass.setBindGroup(
              0,
              this.createBindGroup(
                this.renderPipeline!,
                this.floorUniformBuffer!,
                this.floorLightingBuffer!
              )
            );
            pass.setVertexBuffer(0, floor.getPositionBuffer());
            pass.setVertexBuffer(1, floor.getNormalBuffer());
            pass.setIndexBuffer(floor.getIndexBuffer(), 'uint32');
            pass.drawIndexed(floor.getIndexCount());
          }
        }

        // Sewing bond lines — overlay buffers only (never touch cloth lighting)
        const seamCount =
          'getSeamLineVertexCount' in cloth && typeof cloth.getSeamLineVertexCount === 'function'
            ? (cloth.getSeamLineVertexCount?.() ?? 0)
            : 0;
        if (seamCount > 0 && this.linePipeline) {
          const seamPos =
            'getSeamLinePositionBuffer' in cloth
              ? (cloth as ClothSimulator).getSeamLinePositionBuffer?.() ?? null
              : null;
          const seamNrm =
            'getSeamLineNormalBuffer' in cloth
              ? (cloth as ClothSimulator).getSeamLineNormalBuffer?.() ?? null
              : null;
          if (seamPos && seamNrm) {
            const seamUniform = new Float32Array(32);
            seamUniform.set(mat4ToArray(viewProj), 0);
            seamUniform.set(mat4ToArray(model), 16);
            this.device.queue.writeBuffer(this.overlayUniformBuffer!, 0, seamUniform);

            const seamLighting = new Float32Array(64);
            seamLighting.set(lightingData);
            // Bright gold / amber — matches pattern-editor seam accent
            seamLighting[0] = 1.4;
            seamLighting[1] = 1.2;
            seamLighting[2] = 0.4;
            seamLighting[8] = 0;
            seamLighting[9] = 0;
            seamLighting[10] = 0;
            seamLighting[16] = 0;
            seamLighting[17] = 0;
            seamLighting[18] = 0;
            seamLighting[20] = 1.0;
            seamLighting[21] = 0.78;
            seamLighting[22] = 0.2;
            this.device.queue.writeBuffer(this.overlayLightingBuffer!, 0, seamLighting);

            pass.setPipeline(this.linePipeline);
            pass.setBindGroup(
              0,
              this.createBindGroup(
                this.linePipeline,
                this.overlayUniformBuffer!,
                this.overlayLightingBuffer!
              )
            );
            pass.setVertexBuffer(0, seamPos);
            pass.setVertexBuffer(1, seamNrm);
            pass.draw(seamCount);
          }
        }

        // Quadrant snap grid — faint base cells, brighter hovered cell.
        if (this.gridOverlay) {
          this.drawGridOverlay(
            pass,
            viewProj,
            this.gridCellBuffer,
            this.gridCellVertexCount,
            [0.78, 0.82, 0.9, 0.25]
          );
          this.drawGridOverlay(
            pass,
            viewProj,
            this.gridHighlightBuffer,
            this.gridHighlightVertexCount,
            [0.83, 0.63, 0.09, 0.55]
          );
        }

        drawTranslucentCloth?.();

        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    private createFloorBindGroup(): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.floorPipeline!.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.floorUniformBuffer! },
                },
            ],
        });
    }

    private createBindGroup(
        pipeline: GPURenderPipeline,
        uniformBuffer: GPUBuffer,
        lightingBuffer: GPUBuffer
    ): GPUBindGroup {
        return this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: uniformBuffer,
                    },
                },
                {
                    binding: 1,
                    resource: {
                        buffer: lightingBuffer,
                    },
                },
            ],
        });
    }
}

