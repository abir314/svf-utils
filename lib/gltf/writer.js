"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Writer = void 0;
const path = __importStar(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const fse = __importStar(require("fs-extra"));
const util_1 = require("util");
const image_placeholders_1 = require("../common/image-placeholders");
const IMF = __importStar(require("../common/intermediate-format"));
const MaxBufferSize = 5 << 20;
const DefaultMaterial = {
    pbrMetallicRoughness: {
        baseColorFactor: [0.25, 0.25, 0.25, 1.0],
        metallicFactor: 0.0,
        roughnessFactor: 0.5,
    },
};
function hasTextures(material) {
    var _a;
    return !!((_a = material === null || material === void 0 ? void 0 : material.maps) === null || _a === void 0 ? void 0 : _a.diffuse);
}
/**
 * Utility class for serializing parsed 3D content to local file system as glTF (2.0).
 */
class Writer {
    /**
     * Initializes the writer.
     * @param {IWriterOptions} [options={}] Additional writer options.
     */
    constructor(options = {}) {
        this.bufferViewCache = new Map(); // Cache of existing buffer views, indexed by hash of the binary data they point to
        this.meshHashes = new Map(); // List of hashes of existing gltf.Mesh objects, used for deduplication
        this.bufferViewHashes = new Map(); // List of hashes of existing gltf.BufferView objects, used for deduplication
        this.accessorHashes = new Map(); // List of hashes of existing gltf.Accessor objects, used for deduplication
        this.pendingTasks = [];
        this.stats = {
            materialsDeduplicated: 0,
            meshesDeduplicated: 0,
            accessorsDeduplicated: 0,
            bufferViewsDeduplicated: 0,
        };
        this.options = {
            maxBufferSize: (0, util_1.isNullOrUndefined)(options.maxBufferSize)
                ? MaxBufferSize
                : options.maxBufferSize,
            ignoreMeshGeometry: !!options.ignoreMeshGeometry,
            ignoreLineGeometry: !!options.ignoreLineGeometry,
            ignorePointGeometry: !!options.ignorePointGeometry,
            deduplicate: !!options.deduplicate,
            skipUnusedUvs: !!options.skipUnusedUvs,
            center: !!options.center,
            log: (options && options.log) || function (msg) { },
            filter: (options && options.filter) || ((dbid, fragid) => true),
        };
        // All these properties will be properly initialized in the 'reset' call
        this.manifest = {};
        this.bufferStream = null;
        this.bufferSize = 0;
        this.baseDir = "";
        this.activeSvfMaterials = [];
    }
    /**
     * Outputs scene into glTF.
     * @async
     * @param {IMF.IScene} imf Complete scene in intermediate, in-memory format.
     * @param {string} outputDir Path to output folder.
     */
    async write(imf, outputDir) {
        this.reset(outputDir);
        const scene = this.createScene(imf);
        const scenes = this.manifest.scenes;
        scenes.push(scene);
        if (this.bufferStream) {
            const stream = this.bufferStream;
            this.pendingTasks.push(new Promise((resolve, reject) => {
                stream.on("finish", resolve);
            }));
            this.bufferStream.close();
            this.bufferStream = null;
            this.bufferSize = 0;
        }
        await Promise.all(this.pendingTasks);
        // Remove empty attributes textures or images to avoid errors in glTF validation
        if (this.manifest.textures && this.manifest.textures.length === 0)
            delete this.manifest.textures;
        if (this.manifest.images && this.manifest.images.length === 0)
            delete this.manifest.images;
        const gltfPath = path.join(this.baseDir, "output.gltf");
        this.serializeManifest(this.manifest, gltfPath);
        this.options.log(`Closing gltf output: done`);
        this.options.log(`Stats: ${JSON.stringify(this.stats)}`);
        await this.postprocess(imf, gltfPath);
    }
    reset(outputDir) {
        this.baseDir = outputDir;
        this.manifest = {
            asset: {
                version: "2.0",
                generator: "svf-utils",
                copyright: "2024 (c) Autodesk",
            },
            extensionsUsed: ["KHR_texture_transform"],
            buffers: [],
            bufferViews: [],
            accessors: [],
            meshes: [],
            materials: [],
            nodes: [],
            scenes: [],
            textures: [],
            images: [],
            scene: 0,
        };
        this.bufferStream = null;
        this.bufferSize = 0;
        this.bufferViewCache.clear();
        this.meshHashes = new Map();
        this.bufferViewHashes = new Map();
        this.accessorHashes = new Map();
        this.pendingTasks = [];
        this.activeSvfMaterials = [];
        this.stats = {
            materialsDeduplicated: 0,
            meshesDeduplicated: 0,
            accessorsDeduplicated: 0,
            bufferViewsDeduplicated: 0,
        };
    }
    async postprocess(imf, gltfPath) { }
    serializeManifest(manifest, outputPath) {
        fse.writeFileSync(outputPath, JSON.stringify(manifest, null, 4));
    }
    createScene(imf) {
        fse.ensureDirSync(this.baseDir);
        let scene = {
            nodes: [],
        };
        const manifestNodes = this.manifest.nodes;
        const manifestMaterials = this.manifest
            .materials;
        const rootNode = { children: [] }; // Root node with transform to glTF coordinate system
        const xformNode = { children: [] }; // Transform node with additional global transform (e.g., moving model to origin)
        scene.nodes.push(manifestNodes.push(rootNode) - 1);
        rootNode.children.push(manifestNodes.push(xformNode) - 1);
        // Setup transformation to glTF coordinate system
        const metadata = imf.getMetadata();
        if (metadata["world up vector"] &&
            metadata["world front vector"] &&
            metadata["distance unit"]) {
            const up = metadata["world up vector"].XYZ;
            const front = metadata["world front vector"].XYZ;
            const distanceUnit = metadata["distance unit"].value;
            if (up && front && distanceUnit) {
                const left = [
                    up[1] * front[2] - up[2] * front[1],
                    up[2] * front[0] - up[0] * front[2],
                    up[0] * front[1] - up[1] * front[0],
                ];
                if (left[0] * left[0] + left[1] * left[1] + left[2] * left[2] > 0.0) {
                    let scale = 1.0;
                    switch (distanceUnit) {
                        case "centimeter":
                        case "cm":
                            scale = 0.01;
                            break;
                        case "millimeter":
                        case "mm":
                            scale = 0.001;
                            break;
                        case "foot":
                        case "ft":
                            scale = 0.3048;
                            break;
                        case "inch":
                        case "in":
                            scale = 0.0254;
                            break;
                        default: // "meter" / "m"
                            scale = 1.0;
                    }
                    rootNode.matrix = [
                        left[0] * scale,
                        up[0] * scale,
                        front[0] * scale,
                        0,
                        left[1] * scale,
                        up[1] * scale,
                        front[1] * scale,
                        0,
                        left[2] * scale,
                        up[2] * scale,
                        front[2] * scale,
                        0,
                        0,
                        0,
                        0,
                        1,
                    ];
                }
                else {
                    console.warn("Could not compute world matrix, leaving it as identity...");
                }
            }
        }
        // Setup translation to origin when enabled
        if (metadata["world bounding box"] && this.options.center) {
            const boundsMin = metadata["world bounding box"].minXYZ;
            const boundsMax = metadata["world bounding box"].maxXYZ;
            if (boundsMin && boundsMax) {
                let translation = [
                    -0.5 * (boundsMin[0] + boundsMax[0]),
                    -0.5 * (boundsMin[1] + boundsMax[1]),
                    -0.5 * (boundsMin[2] + boundsMax[2]),
                ];
                xformNode.matrix = [
                    1,
                    0,
                    0,
                    0,
                    0,
                    1,
                    0,
                    0,
                    0,
                    0,
                    1,
                    0,
                    translation[0],
                    translation[1],
                    translation[2],
                    1,
                ];
            }
        }
        const nodeIndices = xformNode.children;
        this.options.log(`Writing scene nodes...`);
        const { filter } = this.options;
        for (let i = 0, len = imf.getNodeCount(); i < len; i++) {
            const fragment = imf.getNode(i);
            // Currently we only support flat lists of objects, no hierarchies
            if (fragment.kind !== IMF.NodeKind.Object) {
                continue;
            }
            if (!filter(fragment.dbid, i)) {
                continue;
            }
            const material = imf.getMaterial(fragment.material);
            // Only output UVs if there are any textures or if the user specifically asked not to skip unused UVs
            const outputUvs = hasTextures(material) || !this.options.skipUnusedUvs;
            const node = this.createNode(fragment, imf, outputUvs);
            // Only output nodes that have a mesh
            if (!(0, util_1.isUndefined)(node.mesh)) {
                nodeIndices.push(manifestNodes.push(node) - 1);
            }
        }
        this.options.log(`Writing materials...`);
        if (this.options.deduplicate) {
            const hashes = [];
            const newMaterialIndices = new Uint16Array(imf.getMaterialCount());
            for (const [i, activeMaterialID] of this.activeSvfMaterials.entries()) {
                const material = imf.getMaterial(activeMaterialID);
                const hash = this.computeMaterialHash(material);
                const match = hashes.indexOf(hash);
                if (match === -1) {
                    // If this is a first occurrence of the hash in the array, output a new material
                    newMaterialIndices[i] = manifestMaterials.length;
                    manifestMaterials.push(this.createMaterial(material, imf));
                    hashes.push(hash);
                }
                else {
                    // Otherwise skip the material, and record an index to the first match below
                    this.options.log(`Skipping a duplicate material (hash: ${hash})`);
                    newMaterialIndices[i] = match;
                    this.stats.materialsDeduplicated++;
                }
            }
            // Update material indices in all mesh primitives
            for (const mesh of this.manifest.meshes) {
                for (const primitive of mesh.primitives) {
                    if (!(0, util_1.isUndefined)(primitive.material)) {
                        primitive.material = newMaterialIndices[primitive.material];
                    }
                }
            }
        }
        else {
            for (const activeMaterialID of this.activeSvfMaterials) {
                const material = imf.getMaterial(activeMaterialID);
                const mat = this.createMaterial(material, imf);
                manifestMaterials.push(mat);
            }
        }
        this.options.log(`Writing scene: done`);
        return scene;
    }
    createNode(fragment, imf, outputUvs) {
        var _a;
        let node = {
            name: ((_a = fragment.objectId) === null || _a === void 0 ? void 0 : _a.toString()) || fragment.dbid.toString(),
        };
        if (fragment.transform) {
            switch (fragment.transform.kind) {
                case IMF.TransformKind.Matrix:
                    node.matrix = fragment.transform.elements;
                    break;
                case IMF.TransformKind.Decomposed:
                    if (fragment.transform.scale) {
                        const s = fragment.transform.scale;
                        node.scale = [s.x, s.y, s.z];
                    }
                    if (fragment.transform.rotation) {
                        const r = fragment.transform.rotation;
                        node.rotation = [r.x, r.y, r.z, r.w];
                    }
                    if (fragment.transform.translation) {
                        const t = fragment.transform.translation;
                        node.translation = [t.x, t.y, t.z];
                    }
                    break;
            }
        }
        const geometry = imf.getGeometry(fragment.geometry);
        let mesh = undefined;
        switch (geometry.kind) {
            case IMF.GeometryKind.Mesh:
                mesh = this.createMeshGeometry(geometry, imf, outputUvs);
                break;
            case IMF.GeometryKind.Lines:
                mesh = this.createLineGeometry(geometry, imf);
                break;
            case IMF.GeometryKind.Points:
                mesh = this.createPointGeometry(geometry, imf);
                break;
            case IMF.GeometryKind.Empty:
                console.warn("Could not find mesh for fragment", fragment);
                break;
        }
        if (mesh && mesh.primitives.length > 0) {
            let materialID = this.activeSvfMaterials.indexOf(fragment.material);
            if (materialID === -1) {
                materialID = this.activeSvfMaterials.length;
                this.activeSvfMaterials.push(fragment.material);
            }
            for (const primitive of mesh.primitives) {
                primitive.material = materialID;
            }
            node.mesh = this.addMesh(mesh);
        }
        return node;
    }
    addMesh(mesh) {
        const meshes = this.manifest.meshes;
        const hash = this.computeMeshHash(mesh);
        const match = this.options.deduplicate
            ? this.meshHashes.get(hash)
            : undefined;
        if (match !== undefined) {
            this.options.log(`Skipping a duplicate mesh (${hash})`);
            this.stats.meshesDeduplicated++;
            return match;
        }
        else {
            if (this.options.deduplicate) {
                this.meshHashes.set(hash, this.meshHashes.size);
            }
            return meshes.push(mesh) - 1;
        }
    }
    createMeshGeometry(geometry, imf, outputUvs) {
        let mesh = {
            primitives: [],
        };
        if (this.options.ignoreMeshGeometry) {
            return mesh;
        }
        // Output index buffer
        const indices = geometry.getIndices();
        const indexBufferView = this.createBufferView(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
        const indexBufferViewID = this.addBufferView(indexBufferView);
        const indexAccessor = this.createAccessor(indexBufferViewID, 5123, indexBufferView.byteLength / 2, "SCALAR");
        const indexAccessorID = this.addAccessor(indexAccessor);
        // Output vertex buffer
        const vertices = geometry.getVertices();
        const positionBounds = this.computeBoundsVec3(vertices); // Compute bounds manually, just in case
        const positionBufferView = this.createBufferView(Buffer.from(vertices.buffer, vertices.byteOffset, vertices.byteLength));
        const positionBufferViewID = this.addBufferView(positionBufferView);
        const positionAccessor = this.createAccessor(positionBufferViewID, 5126, positionBufferView.byteLength / 4 / 3, "VEC3", positionBounds.min, positionBounds.max /*[fragmesh.min.x, fragmesh.min.y, fragmesh.min.z], [fragmesh.max.x, fragmesh.max.y, fragmesh.max.z]*/);
        const positionAccessorID = this.addAccessor(positionAccessor);
        // Output normals buffer
        let normalAccessorID = undefined;
        const normals = geometry.getNormals();
        if (normals) {
            const normalBufferView = this.createBufferView(Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength));
            const normalBufferViewID = this.addBufferView(normalBufferView);
            const normalAccessor = this.createAccessor(normalBufferViewID, 5126, normalBufferView.byteLength / 4 / 3, "VEC3");
            normalAccessorID = this.addAccessor(normalAccessor);
        }
        // Output color buffer
        let colorAccessorID = undefined;
        const colors = geometry.getColors();
        if (colors) {
            const colorBufferView = this.createBufferView(Buffer.from(colors.buffer, colors.byteOffset, colors.byteLength));
            const colorBufferViewID = this.addBufferView(colorBufferView);
            const colorAccessor = this.createAccessor(colorBufferViewID, 5126, colorBufferView.byteLength / 4 / 4, "VEC4");
            colorAccessorID = this.addAccessor(colorAccessor);
        }
        // Output UV buffers
        let uvAccessorID = undefined;
        if (geometry.getUvChannelCount() > 0 && outputUvs) {
            const uvs = geometry.getUvs(0);
            const uvBufferView = this.createBufferView(Buffer.from(uvs.buffer, uvs.byteOffset, uvs.byteLength));
            const uvBufferViewID = this.addBufferView(uvBufferView);
            const uvAccessor = this.createAccessor(uvBufferViewID, 5126, uvBufferView.byteLength / 4 / 2, "VEC2");
            uvAccessorID = this.addAccessor(uvAccessor);
        }
        mesh.primitives.push({
            mode: 4,
            attributes: {
                POSITION: positionAccessorID,
            },
            indices: indexAccessorID,
        });
        if (!(0, util_1.isUndefined)(normalAccessorID)) {
            mesh.primitives[0].attributes.NORMAL = normalAccessorID;
        }
        if (!(0, util_1.isUndefined)(colorAccessorID)) {
            mesh.primitives[0].attributes.COLOR_0 = colorAccessorID;
        }
        if (!(0, util_1.isUndefined)(uvAccessorID)) {
            mesh.primitives[0].attributes.TEXCOORD_0 = uvAccessorID;
        }
        return mesh;
    }
    createLineGeometry(geometry, imf) {
        let mesh = {
            primitives: [],
        };
        if (this.options.ignoreLineGeometry) {
            return mesh;
        }
        // Output index buffer
        const indices = geometry.getIndices();
        const indexBufferView = this.createBufferView(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
        const indexBufferViewID = this.addBufferView(indexBufferView);
        const indexAccessor = this.createAccessor(indexBufferViewID, 5123, indexBufferView.byteLength / 2, "SCALAR");
        const indexAccessorID = this.addAccessor(indexAccessor);
        // Output vertex buffer
        const vertices = geometry.getVertices();
        const positionBounds = this.computeBoundsVec3(vertices);
        const positionBufferView = this.createBufferView(Buffer.from(vertices.buffer, vertices.byteOffset, vertices.byteLength));
        const positionBufferViewID = this.addBufferView(positionBufferView);
        const positionAccessor = this.createAccessor(positionBufferViewID, 5126, positionBufferView.byteLength / 4 / 3, "VEC3", positionBounds.min, positionBounds.max);
        const positionAccessorID = this.addAccessor(positionAccessor);
        // Output color buffer
        let colorAccessorID = undefined;
        const colors = geometry.getColors();
        if (colors) {
            const colorBufferView = this.createBufferView(Buffer.from(colors.buffer, colors.byteOffset, colors.byteLength));
            const colorBufferViewID = this.addBufferView(colorBufferView);
            const colorAccessor = this.createAccessor(colorBufferViewID, 5126, colorBufferView.byteLength / 4 / 3, "VEC3");
            colorAccessorID = this.addAccessor(colorAccessor);
        }
        mesh.primitives.push({
            mode: 1,
            attributes: {
                POSITION: positionAccessorID,
            },
            indices: indexAccessorID,
        });
        if (!(0, util_1.isUndefined)(colorAccessorID)) {
            mesh.primitives[0].attributes["COLOR_0"] = colorAccessorID;
        }
        return mesh;
    }
    createPointGeometry(geometry, imf) {
        let mesh = {
            primitives: [],
        };
        if (this.options.ignorePointGeometry) {
            return mesh;
        }
        // Output vertex buffer
        const vertices = geometry.getVertices();
        const positionBounds = this.computeBoundsVec3(vertices);
        const positionBufferView = this.createBufferView(Buffer.from(vertices.buffer, vertices.byteOffset, vertices.byteLength));
        const positionBufferViewID = this.addBufferView(positionBufferView);
        const positionAccessor = this.createAccessor(positionBufferViewID, 5126, positionBufferView.byteLength / 4 / 3, "VEC3", positionBounds.min, positionBounds.max);
        const positionAccessorID = this.addAccessor(positionAccessor);
        // Output color buffer
        let colorAccessorID = undefined;
        const colors = geometry.getColors();
        if (colors) {
            const colorBufferView = this.createBufferView(Buffer.from(colors.buffer, colors.byteOffset, colors.byteLength));
            const colorBufferViewID = this.addBufferView(colorBufferView);
            const colorAccessor = this.createAccessor(colorBufferViewID, 5126, colorBufferView.byteLength / 4 / 3, "VEC3");
            colorAccessorID = this.addAccessor(colorAccessor);
        }
        mesh.primitives.push({
            mode: 0,
            attributes: {
                POSITION: positionAccessorID,
            },
        });
        if (!(0, util_1.isUndefined)(colorAccessorID)) {
            mesh.primitives[0].attributes["COLOR_0"] = colorAccessorID;
        }
        return mesh;
    }
    addBufferView(bufferView) {
        const bufferViews = this.manifest.bufferViews;
        const hash = this.computeBufferViewHash(bufferView);
        const match = this.options.deduplicate
            ? this.bufferViewHashes.get(hash)
            : undefined;
        if (match !== undefined) {
            this.options.log(`Skipping a duplicate buffer view (${hash})`);
            this.stats.bufferViewsDeduplicated++;
            return match;
        }
        else {
            if (this.options.deduplicate) {
                this.bufferViewHashes.set(hash, this.bufferViewHashes.size);
            }
            return bufferViews.push(bufferView) - 1;
        }
    }
    createBufferView(data) {
        const hash = this.computeBufferHash(data);
        const cache = this.bufferViewCache.get(hash);
        if (this.options.deduplicate && cache) {
            this.options.log(`Skipping a duplicate buffer (${hash})`);
            return cache;
        }
        const manifestBuffers = this.manifest.buffers;
        // Prepare new writable stream if needed
        if (this.bufferStream === null ||
            this.bufferSize > this.options.maxBufferSize) {
            if (this.bufferStream) {
                const stream = this.bufferStream;
                this.pendingTasks.push(new Promise((resolve, reject) => {
                    stream.on("finish", resolve);
                }));
                this.bufferStream.close();
                this.bufferStream = null;
                this.bufferSize = 0;
            }
            const bufferUri = `${manifestBuffers.length}.bin`;
            manifestBuffers.push({ uri: bufferUri, byteLength: 0 });
            const bufferPath = path.join(this.baseDir, bufferUri);
            this.bufferStream = fse.createWriteStream(bufferPath);
        }
        const bufferID = manifestBuffers.length - 1;
        const buffer = manifestBuffers[bufferID];
        this.bufferStream.write(data);
        this.bufferSize += data.byteLength;
        const bufferView = {
            buffer: bufferID,
            byteOffset: buffer.byteLength,
            byteLength: data.byteLength,
        };
        buffer.byteLength += bufferView.byteLength;
        if (buffer.byteLength % 4 !== 0) {
            // Pad to 4-byte multiples
            const pad = 4 - (buffer.byteLength % 4);
            this.bufferStream.write(new Uint8Array(pad));
            this.bufferSize += pad;
            buffer.byteLength += pad;
        }
        if (this.options.deduplicate) {
            this.bufferViewCache.set(hash, bufferView);
        }
        return bufferView;
    }
    addAccessor(accessor) {
        const accessors = this.manifest.accessors;
        const hash = this.computeAccessorHash(accessor);
        const match = this.options.deduplicate
            ? this.accessorHashes.get(hash)
            : undefined;
        if (match !== undefined) {
            this.options.log(`Skipping a duplicate accessor (${hash})`);
            this.stats.accessorsDeduplicated++;
            return match;
        }
        else {
            if (this.options.deduplicate) {
                this.accessorHashes.set(hash, this.accessorHashes.size);
            }
            return accessors.push(accessor) - 1;
        }
    }
    createAccessor(bufferViewID, componentType, count, type, min, max) {
        const accessor = {
            bufferView: bufferViewID,
            componentType: componentType,
            count: count,
            type: type,
        };
        if (!(0, util_1.isUndefined)(min)) {
            accessor.min = min.map(Math.fround);
        }
        if (!(0, util_1.isUndefined)(max)) {
            accessor.max = max.map(Math.fround);
        }
        return accessor;
    }
    createMaterial(mat, imf) {
        var _a, _b;
        // console.log('writing material', mat)
        if (!mat) {
            return DefaultMaterial;
        }
        const diffuse = mat.diffuse;
        let material = {
            pbrMetallicRoughness: {
                baseColorFactor: [diffuse.x, diffuse.y, diffuse.z, 1.0],
                metallicFactor: mat.metallic,
                roughnessFactor: mat.roughness > 1.0 ? 1.0 : mat.roughness,
            },
        };
        if (!(0, util_1.isUndefined)(mat.opacity) &&
            mat.opacity < 1.0 &&
            material.pbrMetallicRoughness.baseColorFactor) {
            material.alphaMode = "BLEND";
            material.pbrMetallicRoughness.baseColorFactor[3] = mat.opacity;
        }
        if (mat.maps) {
            const manifestTextures = this.manifest.textures;
            if (mat.maps.diffuse) {
                const textureID = manifestTextures.length;
                manifestTextures.push(this.createTexture(mat.maps.diffuse, imf));
                material.pbrMetallicRoughness.baseColorTexture = {
                    index: textureID,
                    texCoord: 0,
                    extensions: {
                        KHR_texture_transform: {
                            scale: [(_a = mat.scale) === null || _a === void 0 ? void 0 : _a.x, (_b = mat.scale) === null || _b === void 0 ? void 0 : _b.y],
                        },
                    },
                };
            }
        }
        return material;
    }
    createTexture(uri, imf) {
        const manifestImages = this.manifest.images;
        let imageID = manifestImages.findIndex((image) => image.uri === uri);
        if (imageID === -1) {
            imageID = manifestImages.length;
            const normalizedUri = uri
                .toLowerCase()
                .split(/[\/\\]/)
                .join(path.sep);
            manifestImages.push({ uri: normalizedUri });
            const filePath = path.join(this.baseDir, normalizedUri);
            fse.ensureDirSync(path.dirname(filePath));
            let imageData = imf.getImage(normalizedUri);
            if (!imageData) {
                // Default to a placeholder image based on the extension
                switch (normalizedUri.substr(normalizedUri.lastIndexOf("."))) {
                    case ".jpg":
                    case ".jpeg":
                        imageData = image_placeholders_1.ImagePlaceholder.JPG;
                        break;
                    case ".png":
                        imageData = image_placeholders_1.ImagePlaceholder.PNG;
                        break;
                    case ".bmp":
                        imageData = image_placeholders_1.ImagePlaceholder.BMP;
                        break;
                    case ".gif":
                        imageData = image_placeholders_1.ImagePlaceholder.GIF;
                        break;
                    default:
                        throw new Error(`Unsupported image format for ${normalizedUri}`);
                }
            }
            fse.writeFileSync(filePath, imageData);
        }
        return { source: imageID };
    }
    computeMeshHash(mesh) {
        return mesh.primitives
            .map((p) => {
            return `${p.mode || ""}/${p.material || ""}/${p.indices}/${p.attributes["POSITION"] || ""}/${p.attributes["NORMAL"] || ""}/${p.attributes["TEXCOORD_0"] || ""}/${p.attributes["COLOR_0"] || ""}`;
        })
            .join("/");
    }
    computeBufferViewHash(bufferView) {
        return `${bufferView.buffer}/${bufferView.byteLength}/${bufferView.byteOffset || ""}/${bufferView.byteStride || ""}`;
    }
    computeAccessorHash(accessor) {
        return `${accessor.type}/${accessor.componentType}/${accessor.count}/${accessor.bufferView || "X"}`;
    }
    computeBufferHash(buffer) {
        const hash = crypto_1.default.createHash("md5");
        hash.update(buffer);
        return hash.digest("hex");
    }
    computeMaterialHash(material) {
        if (!material) {
            return "null";
        }
        const hash = crypto_1.default.createHash("md5");
        hash.update(JSON.stringify(material)); // TODO
        return hash.digest("hex");
    }
    computeBoundsVec3(array) {
        const min = [array[0], array[1], array[2]];
        const max = [array[0], array[1], array[2]];
        for (let i = 0; i < array.length; i += 3) {
            min[0] = Math.min(min[0], array[i]);
            max[0] = Math.max(max[0], array[i]);
            min[1] = Math.min(min[1], array[i + 1]);
            max[1] = Math.max(max[1], array[i + 1]);
            min[2] = Math.min(min[2], array[i + 2]);
            max[2] = Math.max(max[2], array[i + 2]);
        }
        return { min, max };
    }
}
exports.Writer = Writer;
