import { Reading } from './reading.model.js'

/** 只和 Mongoose 打交道，业务规则在 service 里 */
export const readingRepository = {
  create(data) {
    return Reading.create(data)
  },
}
