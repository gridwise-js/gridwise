import { BasePrimitive } from "./primitive.mjs";
import { Kernel, AllocateBuffer, WriteGPUBuffer } from "./primitive.mjs";
import { BaseTestSuite } from "./testsuite.mjs";

export class BaseMatrixTranspose extends BasePrimitive {
  constructor(args) {
    super(args);

    /* buffer registration should be done in subclass */

    /* by default, delegate to simple call from BasePrimitive */
    this.getDispatchGeometry = this.getSimpleDispatchGeometry;
  }
}

class WorkQueueMatrixTranspose extends BaseMatrixTranspose {
  constructor(args) {
    super(args);

    this.knownBuffers = [
      "inputBuffer",
      "outputBuffer",
      "debugBuffer",
      "workQueue",
      "workUnitsComplete",
    ];

    for (const knownBuffer of this.knownBuffers) {
      /* we passed an existing buffer into the constructor */
      if (knownBuffer in args) {
        this.registerBuffer({
          label: knownBuffer,
          buffer: args[knownBuffer],
          device: this.device,
        });
        delete this[knownBuffer]; // let's make sure it's in one place only
      }
    }
  }

  get bytesTransferred() {
    return (
      this.getBuffer("inputBuffer").size + this.getBuffer("outputBuffer").size
    );
  }

  /** parameters:
   * - matrixWidthHeight: input matrix has edge length of this
   *   Uniform param
   * - baseCaseWidthHeight: size when we stop recursing and just do the transpose
   *   Currently a uniform param; could be a compile-time param though
   * - workgroupCount (should fill the machine)
   */

  /*
   * This encoding scheme packs a region's position (x, y) and side-length (sz)
   * into a single 32-bit integer. It uses a relative coordinate system where the
   * fundamental unit is a "tile" of the minimum possible region size, 2^b.
   *
   * The bit allocation is 14 bits for the x-tile, 14 for the y-tile, and 4 for
   * the relative size exponent. This 14/14/4 split is optimal because it
   * maximizes the tile grid to 16,384 x 16,384 (2^14 x 2^14), which is the
   * largest possible spatial resolution that fits within 32 bits. The final
   * value is biased by +1 to reserve the zero value for special use cases.
   *
   * Bit Layout:
   * | 4 bits: Relative Size | 14 bits: Y-Tile | 14 bits: X-Tile |
   */

  /**
   * Encodes a region's position and side-length into a single 32-bit integer.
   *
   * @param {number} x The absolute x-coordinate of the region.
   * @param {number} y The absolute y-coordinate of the region.
   * @param {number} sz The side-length of the square region (must be a power of 2).
   * @param {number} blog2 The minimum size exponent (minimum region size is 2^b).
   * @returns {number} The encoded 32-bit integer, or 0 if inputs are invalid.
   */
  regionToU32({ x, y, sz, blog2 }) {
    // --- Validate Inputs ---
    const isPowerOfTwo = sz > 0 && (sz & (sz - 1)) === 0;
    if (!isPowerOfTwo || x % sz !== 0 || y % sz !== 0) {
      return 0; // Invalid side-length or alignment
    }

    const absoluteExp = Math.log2(sz); // The absolute exponent of the side-length
    if (absoluteExp < blog2) {
      return 0; // Region is smaller than the minimum allowed size
    }

    // --- Calculate Relative (Tile) Units ---
    const relativeExp = absoluteExp - blog2 + 1; // +1 to ensure non-zero packedValue
    const x_tile = x >> blog2; // x / 2^b
    const y_tile = y >> blog2; // y / 2^b

    // --- Validate Against the Fixed 14-bit Tile Grid ---
    const TILE_GRID_MAX = 1 << 14;
    if (x_tile >= TILE_GRID_MAX || y_tile >= TILE_GRID_MAX) {
      return 0; // Coordinates are outside the maximum supported matrix size
    }

    // --- Pack and Bias ---
    const packedValue = (relativeExp << 28) | (y_tile << 14) | x_tile;
    return packedValue;
  }

  /**
   * Decodes a 32-bit integer back into a region's position and side-length.
   *
   * @param {number} encodedValue The 32-bit integer to decode.
   * @param {number} blog2 The minimum size exponent (minimum region size is 2^b).
   * @returns {{x: number, y: number, sz: number}|null} An object with the region's
   * properties, or null if the encoded value is the reserved value 0.
   */
  u32ToRegion(packedValue, blog2) {
    if (packedValue === 0) {
      return null; // 0 is the reserved "special value"
    }

    // --- Un-bias and Unpack ---
    const relativeExp = (packedValue >> 28) - 1;
    const y_tile = (packedValue >> 14) & 0x3fff; // 0x3FFF is the mask for 14 bits
    const x_tile = packedValue & 0x3fff;

    // --- Convert from Tile Units back to Absolute Values ---
    return {
      x: x_tile << blog2,
      y: y_tile << blog2,
      sz: 1 << (relativeExp + blog2), // sz = 2^(relativeExp + b)
    };
  }

  workQueueMatrixTransposeWGSL = () => {
    let kernel = /* wgsl */ `
    ${this.fnDeclarations.enableSubgroupsIfAppropriate()}
    ${this.fnDeclarations.commonDefinitions()}
    ${this.fnDeclarations.subgroupZero()}

    struct TransposeParameters {
      matrixWidthHeight: u32, /* width === height */
      baseCaseWidthHeight: u32,
      totalWorkUnits: u32,
    };

    /*
     * This encoding scheme packs a region's position (x, y) and side-length (sz)
     * into a single 32-bit integer. It uses a relative coordinate system where the
     * fundamental unit is a "tile" of the minimum possible region size, 2^b.
     *
     * The bit allocation is 14 bits for the x-tile, 14 for the y-tile, and 4 for
     * the relative size exponent. This 14/14/4 split is optimal because it
     * maximizes the tile grid to 16,384 x 16,384 (2^14 x 2^14), which is the
     * largest possible spatial resolution that fits within 32 bits. The final
     * value is biased by +1 to reserve the zero value for special use cases.
     *
     * Bit Layout:
     * | 4 bits: Relative Size | 14 bits: Y-Tile | 14 bits: X-Tile |
     */
    struct Region {
      x: u32,
      y: u32,
      sz: u32
    };

    const BASE_CASE_WIDTH_HEIGHT: u32 = ${this.baseCaseWidthHeight};
    const BASE_CASE_WIDTH_HEIGHT_LOG2: u32 = ${Math.log2(
      this.baseCaseWidthHeight
    )};

    /// Next two routines better be equivalent to the ones in JS in this file
    ///
    /// Encodes a region's position and side-length into a single 32-bit integer.
    ///
    /// @param x The absolute x-coordinate of the region.
    /// @param y The absolute y-coordinate of the region.
    /// @param sz The side-length of the square region (must be a power of 2).
    /// @param blog2 The minimum size exponent (minimum region size is 2^b).
    /// @returns The encoded 32-bit integer, or 0u if inputs are invalid.
    fn regionToU32(region: Region, blog2: u32) -> u32 {
      // --- Validate Inputs ---
      let x = region.x;
      let y = region.y;
      let sz = region.sz;
      let isPowerOfTwo = (sz > 0u) && ((sz & (sz - 1u)) == 0u);
      if (!isPowerOfTwo || (x % sz) != 0u || (y % sz) != 0u) {
        return 0u; // Invalid side-length or alignment
      }

      let absoluteExp = countTrailingZeros(sz); // Efficiently finds log2(sz)
      if (absoluteExp < blog2) {
        return 0u; // Region is smaller than the minimum allowed size
      }

      // --- Calculate Relative (Tile) Units ---
      /* +1 below ensures we don't have a 0 work unit */
      let relativeExp = absoluteExp - blog2 + 1;
      let x_tile = x >> blog2;
      let y_tile = y >> blog2;

      // --- Validate Against the Fixed 14-bit Tile Grid ---
      let TILE_GRID_MAX = 1u << 14u;
      if (x_tile >= TILE_GRID_MAX || y_tile >= TILE_GRID_MAX) {
        return 0u; // Coordinates are outside the maximum supported matrix size
      }

      // --- Pack and Bias ---
      let packedValue = (relativeExp << 28u) | (y_tile << 14u) | x_tile;
      return packedValue;
    }

    /// Decodes a 32-bit integer back into a region's position and side-length.
    ///
    /// @param encodedValue The 32-bit integer to decode.
    /// @param b The minimum size exponent (minimum region size is 2^b).
    /// @returns A Region struct. If the input was the reserved value 0,
    /// the returned struct will have a side-length 'sz' of 0.
    fn u32ToRegion(packedValue: u32, blog2: u32) -> Region {
      if (packedValue == 0u) {
        return Region(0u, 0u, 0u); // 0u is the reserved value
      }

      // --- Un-bias and Unpack ---
      let relativeExp = (packedValue >> 28u) - 1;
      let y_tile = (packedValue >> 14u) & 0x3FFFu; // 0x3FFF is the mask for 14 bits
      let x_tile = packedValue & 0x3FFFu;

      // --- Convert from Tile Units back to Absolute Values ---
      let sz_val = 1u << (relativeExp + blog2); // sz = 2^(relativeExp + b)
      let x_val = x_tile << blog2;
      let y_val = y_tile << blog2;

      return Region(x_val, y_val, sz_val);
    }

    fn baseCaseTranspose(
        builtinsUniform: BuiltinsUniform,
        builtinsNonuniform: BuiltinsNonuniform,
        regionIn: Region,
        matrixWidthHeight: u32) {
      /* uses wg_matrix */
      /** can be more efficient if we pad the matrix
       * in workgroup memory to avoid bank conflicts */
      /* absolutely this is hardcoded: one thread per matrix element */
      var lidx = builtinsNonuniform.lidx;
      var offsetx = (lidx % regionIn.sz);
      var offsety = (lidx / regionIn.sz);
      var xsrc = regionIn.x + offsetx;
      var ysrc = regionIn.y + offsety;
      var xdest = regionIn.y + offsetx;
      var ydest = regionIn.x + offsety;
      /* read into workgroup memory in row-major order */
      wg_matrix[lidx] = inputBuffer[ysrc * matrixWidthHeight + xsrc];
      /* read out of workgroup memory in column-major order */
      workgroupBarrier();
      outputBuffer[ydest * matrixWidthHeight + xdest] =
        wg_matrix[offsetx * regionIn.sz + offsety];

      /* this serial code works */
      // if (builtinsNonuniform.lidx == 0) {
        /* do it in one thread for now, this will become whole-workgroup */
        // for (var xx = region.x; xx < region.x + region.sz; xx++) {
        //   for (var yy = region.y; yy < region.y + region.sz; yy++) {
        //     outputBuffer[xx * matrixWidthHeight + yy] =
        //       inputBuffer[yy * matrixWidthHeight + xx];
        //   }
        // }
      // }
    }

    @group(0) @binding(0)
    var<storage, read_write> outputBuffer: array<${this.datatype}>;

    @group(0) @binding(1)
    var<storage, read> inputBuffer: array<${this.datatype}>;

    /* u32: points to INPUT (encodes [ x, y, size ]) */
    @group(0) @binding(2)
    var<storage, read_write> workQueue: array<atomic<u32>>;

    @group(0) @binding(3)
    var<storage, read_write> workUnitsComplete: atomic<u32>;

    @group(0) @binding(4)
    var<storage, read_write> debugBuffer: array<atomic<${this.datatype}>>;

    @group(1) @binding(0)
    var<uniform> transposeParameters : TransposeParameters;

    var<workgroup> wg_matrix: array<u32, ${
      this.baseCaseWidthHeight * this.baseCaseWidthHeight
    }>;

    var<workgroup> wg_broadcast_workUnit: u32;
    var<workgroup> wg_broadcast_currentworkUnitsComplete: u32;
    var<workgroup> wg_broadcast_foundWork: u32;

    @compute @workgroup_size(${this.workgroupSize}, 1, 1)
    fn workQueueMatrixTranspose(builtinsUniform: BuiltinsUniform,
        builtinsNonuniform: BuiltinsNonuniform) {
      var matrixWidthHeight = transposeParameters.matrixWidthHeight;
      var baseCaseWidthHeight = transposeParameters.baseCaseWidthHeight;
      let workQueueLength = arrayLength(&workQueue);
      var totalWorkUnits = transposeParameters.totalWorkUnits;
      let wgid = builtinsUniform.wgid.x;
      var readSearchLocation: u32 = wgid;
      var writeSearchLocation: u32 = wgid;

      for (var i = 0; i < 3000000; i++) { /* so we don't go into an infinite loop */
      // loop { /* this is the loop we want when we're production-ready */
        /* for now, invariant is we enter this loop with no work */

        /* Consume (remove work)
         * - Find a full slot (via atomic load)
         * - Atomic weak compare-exchange work unit with that slot
         * - Successful compare-exchange means you own that work unit
         * - Failure: EITHER
         *   - Loop over atomic exchanges
         *   - Loop over find-a-full-slot (we are doing this one)
         */
        for (var j = 0u; j < workQueueLength; j++) {
          /* are we done? return if we are */
          if (builtinsNonuniform.lidx == 0) {
            wg_broadcast_currentworkUnitsComplete = atomicLoad(&workUnitsComplete);
            wg_broadcast_foundWork = 0;
          }
          var currentworkUnitsComplete = workgroupUniformLoad(&wg_broadcast_currentworkUnitsComplete);
          if (currentworkUnitsComplete >= totalWorkUnits) { /* Look into why >= has different behavior than == */
            return;
          }
          /* still work to do. */
          /* thread 0 does all the work */
          if (builtinsNonuniform.lidx == 0) {
            /* below plots requests (atomic exchange) as function of how much work we have finished */
            // atomicAdd(&debugBuffer[wg_broadcast_currentworkUnitsComplete], 1u);
            var tempWorkUnit = atomicLoad(&workQueue[readSearchLocation]);
            if (tempWorkUnit != 0) {
              /* there's work at readSearchLocation! */
              var exchangeResult =
                atomicCompareExchangeWeak(&workQueue[readSearchLocation], tempWorkUnit, 0);
              if (exchangeResult.exchanged == true) {
                /* found a piece of work, break out of loop */
                atomicStore(&debugBuffer[wg_broadcast_currentworkUnitsComplete], readSearchLocation);
                wg_broadcast_workUnit = tempWorkUnit;
                wg_broadcast_foundWork = 1;
              } else {
                /* someone else got the work first */
              }
            }
            readSearchLocation = (readSearchLocation + 1) % workQueueLength;
          }
          if (workgroupUniformLoad(&wg_broadcast_foundWork) == 1) {
            break;
          }
        } /* end loop over work queue to find work to consume */
        workgroupBarrier();

        let myWorkUnit = workgroupUniformLoad(&wg_broadcast_workUnit);
        if (myWorkUnit != 0) {
          /* process the work we found */
          /* not sure if there is a case where myWorkUnit == 0, but if we
           * do see that, we can just skip the insert phase */
          var myRegion = u32ToRegion(myWorkUnit, BASE_CASE_WIDTH_HEIGHT_LOG2);
          if (myRegion.sz == baseCaseWidthHeight) {
            /* base case, actually transpose this region */
            baseCaseTranspose(builtinsUniform, builtinsNonuniform, myRegion, matrixWidthHeight);
            if (builtinsNonuniform.lidx == 0) {
              var wuc = atomicAdd(&workUnitsComplete, 1u);
              // below: which workgroup does which base-case matrix transpose?
              // debugBuffer[wuc] = wgid;
            }
          } else {
            /* Insert (add work)
             * - Subdivide work into 4 subpieces, and for each:
             *   - Find an empty slot
             *   - Atomic weak compare-exchange myWork with that slot
             *   - Success means you get back a zero
             *   - Failure: Start over
             */
            /* currently, do this serially in thread zero */
            if (builtinsNonuniform.lidx == 0) {
              for (var j = 0u; j < 4; ) { /* loop until all work is placed in queue */
                var deltaX = select(0u, myRegion.sz / 2, (j & 0x1) != 0);
                var deltaY = select(0u, myRegion.sz / 2, (j & 0x2) != 0);
                var newWorkUnit = regionToU32(Region(myRegion.x + deltaX,
                                                     myRegion.y + deltaY,
                                                     myRegion.sz / 2),
                                              BASE_CASE_WIDTH_HEIGHT_LOG2);
                /* try to post only into an empty slot */
                var tempWorkUnit = atomicLoad(&workQueue[writeSearchLocation]);
                /* Next line: store where you last wrote as a function of work units complete */
                // atomicStore(&debugBuffer[wg_broadcast_currentworkUnitsComplete], writeSearchLocation);
                if (tempWorkUnit == 0) {
                  /* there's an empty slot at writeSearchLocation! */
                  var exchangeResult =
                    atomicCompareExchangeWeak(&workQueue[writeSearchLocation], 0u, newWorkUnit);
                  if (exchangeResult.exchanged == true) {
                    /* successfully posted work, move to next piece of work */
                    j = j + 1;
                  } else {
                    /* someone else got the work first */
                  }
                }
                writeSearchLocation = (writeSearchLocation + 1) % workQueueLength;
              } /* loop over inserting 4 work units */
            } /* subdivide and insert work: I am thread zero */
          } /* if base case or not */
        } /* if valid work unit to consume */
      } /* loop forever until all computation is done */
    } /* end kernel workQueueMatrixTranspose */`;
    return kernel;
  };

  finalizeRuntimeParameters() {
    this.workgroupCount = this.workgroupCount ?? 256;
    this.workgroupSize = 256;
    this.baseCaseWidthHeight = this.baseCaseWidthHeight ?? 16;
    this.baseCaseWidthHeight_log2 = Math.log2(this.baseCaseWidthHeight);

    const inputLength = this.getBuffer("inputBuffer").length;
    this.matrixWidthHeight = Math.sqrt(inputLength);
    this.transposeParameters = new Uint32Array(3);
    this.transposeParameters[0] = this.matrixWidthHeight;
    this.transposeParameters[1] = this.baseCaseWidthHeight;
    // total number of (leaf) work items
    this.transposeParameters[2] =
      (this.matrixWidthHeight / this.baseCaseWidthHeight) ** 2;

    // make this big enough to store all leaves
    this.workQueueSize = this.workQueueSize ?? 4 * this.transposeParameters[2];

    console.info("Transpose parameters", this.transposeParameters);

    this.workQueue = new Uint32Array(
      this.workQueueSize / Uint32Array.BYTES_PER_ELEMENT
    );
    const initialWorkRegion = {
      x: 0,
      y: 0,
      sz: this.matrixWidthHeight,
      blog2: this.baseCaseWidthHeight_log2,
    };
    const initialWork = this.regionToU32(initialWorkRegion);
    this.workQueue[0] = initialWork; /* the entire matrix */

    console.log(
      "initialWorkRegion",
      initialWorkRegion,
      "initialWork",
      initialWork,
      "this.workQueue",
      this.workQueue
    );

    this.workUnitsCompleteLength = 1;
    this.workUnitsCompleteSize =
      this.workUnitsCompleteLength * Uint32Array.BYTES_PER_ELEMENT;
  }
  compute() {
    this.finalizeRuntimeParameters();
    const bufferTypes = [
      ["storage", "read-only-storage", "storage", "storage", "storage"],
      ["uniform"],
    ];
    const bindings = [
      [
        "outputBuffer",
        "inputBuffer",
        "workQueue",
        "workUnitsComplete",
        "debugBuffer",
      ],
      ["transposeParameters"],
    ];
    return [
      new AllocateBuffer({
        label: "transposeParameters",
        size: this.transposeParameters.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      new WriteGPUBuffer({
        label: "transposeParameters",
        cpuSource: this.transposeParameters,
      }),
      new AllocateBuffer({
        label: "workQueue",
        size: this.workQueueSize,
      }),
      new WriteGPUBuffer({
        label: "workQueue",
        cpuSource: this.workQueue,
      }),
      new AllocateBuffer({
        label: "workUnitsComplete",
        size: this.workUnitsCompleteSize,
      }),
      new Kernel({
        kernel: this.workQueueMatrixTransposeWGSL,
        bufferTypes,
        bindings,
        label: `work queue matrix transpose (${this.transposeParameters[0]} x ${this.transposeParameters[0]}) [subgroups: ${this.useSubgroups}]`,
        logKernelCodeToConsole: false,
        getDispatchGeometry: () => {
          return [this.workgroupCount];
        },
      }),
    ];
  }
  validate = (args = {}) => {
    /** if we pass in buffers, use them, otherwise use the named buffers
     * that are stored in the primitive */
    /* assumes that cpuBuffers are populated with useful data */
    const memsrc =
      args.inputBuffer?.cpuBuffer ??
      args.inputBuffer ??
      this.getBuffer("inputBuffer").cpuBuffer;
    const memdest =
      args.outputBuffer?.cpuBuffer ??
      args.outputBuffer ??
      this.getBuffer("outputBuffer").cpuBuffer;
    if (memsrc === memdest) {
      console.warn(
        "Warning: source and destination for transpose are the same buffer",
        "src:",
        memsrc,
        "dest",
        memdest
      );
    }
    const referenceOutput = new Uint32Array(memsrc.length);
    for (let i = 0; i < memsrc.length; i++) {
      const x = i % this.matrixWidthHeight;
      const y = Math.floor(i / this.matrixWidthHeight);
      referenceOutput[y + x * this.matrixWidthHeight] = memsrc[i];
    }
    console.info(
      "length, matrixWidthHeight",
      memsrc.length,
      this.matrixWidthHeight,
      "input",
      memsrc,
      "output",
      memdest,
      "reference",
      referenceOutput,
      "debug",
      this.getBuffer("debugBuffer").cpuBuffer
    );

    /* arrow function to allow use of this.type within it */
    const validates = (args) => {
      return args.cpu === args.gpu;
    };
    let returnString = "";
    let allowedErrors = 5;
    for (let i = 0; i < memdest.length; i++) {
      if (allowedErrors === 0) {
        break;
      }
      const compare = {
        cpu: referenceOutput[i],
        gpu: memdest[i],
        datatype: this.datatype,
        i,
        label: args?.outputKeys?.label,
      };
      if (!validates(compare)) {
        returnString += `\nElement ${i}: expected ${compare.cpu}, instead saw ${compare.gpu} `;
        returnString += `(diff: ${Math.abs(
          (referenceOutput[i] - memdest[i]) / referenceOutput[i]
        )}).`;
        if (this.getBuffer("debugBuffer")) {
          returnString += ` debug[${i}] = ${
            this.getBuffer("debugBuffer").cpuBuffer[i]
          }.`;
        }
        if (this.getBuffer("debug2Buffer")) {
          returnString += ` debug2[${i}] = ${
            this.getBuffer("debug2Buffer").cpuBuffer[i]
          }.`;
        }
        allowedErrors--;
      }
    }
    if (returnString !== "") {
      console.log(
        this.label,
        this,
        "with input",
        memsrc,
        "should validate to (reference)",
        args?.outputKeys?.label ?? "",
        referenceOutput,
        "and actually validates to (GPU output)",
        memdest,
        this.getBuffer("debugBuffer") ? "\ndebugBuffer" : "",
        this.getBuffer("debugBuffer")
          ? this.getBuffer("debugBuffer").cpuBuffer
          : "",
        this.getBuffer("debug2Buffer") ? "\ndebug2Buffer" : "",
        this.getBuffer("debug2Buffer")
          ? this.getBuffer("debug2Buffer").cpuBuffer
          : ""
      );
    }
    return returnString;
  };
}

export const TransposeSizeTimingPlot = {
  x: { field: "inputBytes", label: "Input array size (B)" },
  y: { field: "bandwidth", label: "Achieved bandwidth (GB/s)" },
  stroke: { field: "timing" },
  test_br: "gpuinfo.description",
  caption: "CPU timing (performance.now), GPU timing (timestamps)",
};

const TransposeParams = {
  inputLength: [2 ** 18] /* sqrt(inputLength) == matrix side length */,
  datatype: ["u32"],
  disableSubgroups: [false],
  workgroupCount: [256],
};

export const TransposeRegressionSuite = new BaseTestSuite({
  category: "transpose",
  testSuite: "workqueue",
  trials: 5,
  initializeCPUBuffer: "fisher-yates",
  params: TransposeParams,
  primitive: WorkQueueMatrixTranspose,
  // plots: [TransposeSizeTimingPlot],
});
