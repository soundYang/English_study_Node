/**
 * 文件导入的各项上限（md/48 §5.4 / §8）。
 *
 * 集中放在一处是因为这些数字在三个地方要用：multer 的 limits、zip 防护、
 * 抽取结果的截断。分开写迟早会出现「multer 放行 5MB、zip 防护按 2MB 判」这种
 * 自相矛盾的配置。
 */

/** 单文件上限。200 个词的表格远小于这个数；手机照片也就 2–4MB */
export const MAX_FILE_BYTES = 5 * 1024 * 1024

/** 单次抽取最多返回多少行。再往后反正要分批写入（batch 上限 200/次） */
export const MAX_IMPORT_ROWS = 500

/** zip 内部条目数上限：正常 docx 只有十几个条目 */
export const MAX_ZIP_ENTRIES = 2000

/** 解压后总大小上限。5MB 的压缩包解压出 50MB 已经很可疑了 */
export const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024

/** 压缩比上限。纯文本压缩比通常在 5–20 倍，100 倍基本就是炸弹 */
export const MAX_COMPRESSION_RATIO = 100

/** 前 N 字节里出现 0x00 就当二进制，不再尝试按文本解析 */
export const TEXT_SNIFF_BYTES = 8192

/**
 * 图片像素上限。**与文件大小是两个维度**：5MB 的纯白 PNG 可以解压成 4 亿像素，
 * 解码时要按像素分配内存，爆的是整个进程（见 image-size.js）。
 * 4000 万像素 ≈ 6300×6300，手机原图 / 4K 截图 / 万像素长截图都在线内。
 */
export const MAX_IMAGE_PIXELS = 40_000_000

/** 单边上限：挡住 1080×50000 这种「像素没超但长到离谱」的图 */
export const MAX_IMAGE_SIDE = 30_000
