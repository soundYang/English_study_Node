import { GenerationFailure } from './generation-failure.model.js'

/** 只和 Mongoose 打交道，业务规则在 service 里 */
export const generationFailureRepository = {
  create(data) {
    return GenerationFailure.create(data)
  },
}
