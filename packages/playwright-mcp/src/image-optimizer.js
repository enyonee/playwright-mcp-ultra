/**
 * Image optimizer for Playwright MCP screenshots.
 * Proxy-only: post-processes screenshot results to apply
 * custom quality and maxWidth settings.
 *
 * Uses playwright-core's own PNG/JPEG codecs (no extra deps).
 *
 * Token savings: JPEG quality 50 = ~3-5x smaller base64 than PNG.
 * maxWidth 800 on a 1920px screenshot = ~5x fewer pixels.
 */

const { PNG, jpegjs } = require('playwright-core/lib/utilsBundle');
const { scaleImageToSize } = require(
  require('path').join(
    require('path').dirname(require.resolve('playwright-core/package.json')),
    'lib/utils/isomorphic/imageUtils.js'
  )
);

const IMAGE_OPTIONS_SCHEMA = {
  type: 'object',
  description: 'Image optimization for screenshots. Reduces token usage by compressing/resizing.',
  properties: {
    quality: {
      type: 'number',
      minimum: 1,
      maximum: 100,
      description: 'JPEG quality 1-100 (default: 80). Forces JPEG format. Lower = smaller tokens. 50 is good balance.',
    },
    maxWidth: {
      type: 'number',
      minimum: 50,
      maximum: 4096,
      description: 'Max width in pixels. Image is scaled down proportionally if wider.',
    },
  },
  additionalProperties: false,
};

/**
 * Extract imageOptions from tool arguments.
 */
function extractImageOptions(args) {
  if (!args || typeof args !== 'object' || !args.imageOptions)
    return { imageOptions: null, cleanArgs: args };

  const { imageOptions, ...cleanArgs } = args;
  return { imageOptions, cleanArgs };
}

/**
 * Post-process screenshot result: re-encode with quality, resize if needed.
 */
function applyImageOptimization(result, imageOptions) {
  if (!imageOptions || !result || !result.content)
    return result;

  const quality = imageOptions.quality;
  const maxWidth = imageOptions.maxWidth;
  if (!quality && !maxWidth)
    return result;

  const content = result.content.map(part => {
    if (part.type !== 'image' || !part.data)
      return part;

    try {
      const inputBuffer = Buffer.from(part.data, 'base64');
      const isJpeg = part.mimeType === 'image/jpeg';

      // Декодируем
      let image;
      if (isJpeg)
        image = jpegjs.decode(inputBuffer, { maxMemoryUsageInMB: 512 });
      else
        image = PNG.sync.read(inputBuffer);

      // Ресайз если нужно
      if (maxWidth && image.width > maxWidth) {
        const scale = maxWidth / image.width;
        const newWidth = Math.round(image.width * scale);
        const newHeight = Math.round(image.height * scale);
        image = scaleImageToSize(image, { width: newWidth, height: newHeight });
      }

      // Кодируем в JPEG с заданным quality (или PNG если quality не задан)
      let outputBuffer;
      let mimeType;
      if (quality) {
        // quality задан -> всегда JPEG
        outputBuffer = jpegjs.encode(image, quality).data;
        mimeType = 'image/jpeg';
      } else if (isJpeg) {
        // maxWidth был, quality нет, был JPEG -> оставляем JPEG 80
        outputBuffer = jpegjs.encode(image, 80).data;
        mimeType = 'image/jpeg';
      } else {
        // maxWidth был, quality нет, был PNG -> оставляем PNG
        outputBuffer = PNG.sync.write(image);
        mimeType = 'image/png';
      }

      return {
        ...part,
        data: outputBuffer.toString('base64'),
        mimeType,
      };
    } catch {
      // Если не удалось обработать - вернуть как есть
      return part;
    }
  });

  return { ...result, content };
}

/**
 * Add imageOptions schema to browser_take_screenshot tool.
 */
function injectImageOptionsSchema(tools) {
  for (const tool of tools) {
    if (tool.name !== 'browser_take_screenshot')
      continue;
    if (!tool.inputSchema || !tool.inputSchema.properties)
      continue;

    tool.inputSchema.properties.imageOptions = IMAGE_OPTIONS_SCHEMA;

    if (tool.inputSchema.required)
      tool.inputSchema.required = tool.inputSchema.required.filter(r => r !== 'imageOptions');

    if (tool.inputSchema.additionalProperties === false)
      delete tool.inputSchema.additionalProperties;
  }
}

module.exports = {
  extractImageOptions,
  applyImageOptimization,
  injectImageOptionsSchema,
  IMAGE_OPTIONS_SCHEMA,
};
