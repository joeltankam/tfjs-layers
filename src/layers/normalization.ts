/**
 * @license
 * Copyright 2018 Google LLC
 *
 * Use of this source code is governed by an MIT-style
 * license that can be found in the LICENSE file or at
 * https://opensource.org/licenses/MIT.
 * =============================================================================
 */

/**
 * Normalization layers.
 */

import * as tfc from '@tensorflow/tfjs-core';
import {serialization, Tensor, Tensor1D, Tensor2D, Tensor3D, Tensor4D, tidy, util} from '@tensorflow/tfjs-core';
import {Constraint, ConstraintIdentifier, getConstraint, serializeConstraint} from '../constraints';
import {InputSpec, Layer, LayerArgs} from '../engine/topology';
import {NotImplementedError, ValueError} from '../errors';
import {getInitializer, Initializer, InitializerIdentifier, serializeInitializer} from '../initializers';
import {Shape} from '../keras_format/common';
import {getRegularizer, Regularizer, RegularizerIdentifier, serializeRegularizer} from '../regularizers';
import {Kwargs} from '../types';
import * as generic_utils from '../utils/generic_utils';
import * as math_utils from '../utils/math_utils';
import {getExactlyOneShape, getExactlyOneTensor} from '../utils/types_utils';
import {LayerVariable} from '../variables';


/**
 * Applies batch normalization on x given mean, var, beta and gamma.
 *
 * I.e. returns:
 *   `output = (x - mean) / (sqrt(var) + epsilon) * gamma + beta`
 *
 * @param x Input tensor.
 * @param mean Mean of batch.
 * @param variance Variance of batch.
 * @param beta Tensor with which to center the input.
 * @param gamma Tensor by which to scale the input.
 * @param epsilon Fuzz factor.
 * @returns The result of the batch normalization.
 */
export function batchNormalization(
    x: Tensor, mean: Tensor, variance: Tensor, beta?: Tensor, gamma?: Tensor,
    epsilon = 1e-3): Tensor {
  let out: Tensor;
  if (x.rank === 2) {
    out = tfc.batchNorm2d(
        x as Tensor2D, mean as Tensor2D | Tensor1D,
        variance as Tensor2D | Tensor1D, beta as Tensor2D | Tensor1D,
        gamma as Tensor2D | Tensor1D, epsilon);
  } else if (x.rank === 3) {
    // TODO(cais): Check rank; give proper error message.
    out = tfc.batchNorm3d(
        x as Tensor3D, mean as Tensor3D | Tensor1D,
        variance as Tensor3D | Tensor1D, beta as Tensor3D | Tensor1D,
        gamma as Tensor3D | Tensor1D, epsilon);
  } else if (x.rank === 4) {
    out = tfc.batchNorm4d(
        x as Tensor4D, mean as Tensor4D | Tensor1D,
        variance as Tensor4D | Tensor1D, beta as Tensor4D | Tensor1D,
        gamma as Tensor4D | Tensor1D, epsilon);
  } else {
    throw new NotImplementedError(
        `batchNormalization is not implemented for array of rank ${x.rank} ` +
        `yet`);
  }
  return out;
}

/**
 * Non-broadcasting batch normalization for use in training (not inference).
 *
 * The input is normalized to zero mean and unit variance along the
 * `reductionAxes`, followed by scaling with `gamma` and shifted by `beta`.
 * The result of that is returned as the first element
 * of the returned `Array`. The other two elements are the mean and variance,
 * respectively.
 *
 * @param x Input tensor to be normalized.
 * @param gamma Tensor by which to scale the input.
 * @param beta Tensor by which to center the input.
 * @param reductionAxes Axes over which to normalize.
 * @param epsilon Fuzz factor.
 * @returns An `Array` of three `Tensors`:
 *   [normalized tensor, mean of input, variance of input].
 */
function regularNormalizeBatchInTraining(
    x: Tensor, gamma: Tensor, beta: Tensor, reductionAxes: number[],
    epsilon = 1e-3): [Tensor, Tensor, Tensor] {
  return tidy(() => {
           const meanAndVariance = tfc.moments(x, reductionAxes);
           const mean = meanAndVariance.mean;
           const variance = meanAndVariance.variance;
           const normed =
               batchNormalization(x, mean, variance, beta, gamma, epsilon);
           return [normed, mean, variance];
         }) as [Tensor, Tensor, Tensor];
}

/**
 * Broadcasting batch normalization for use in training (not inference).
 *
 * The input is normalized to zero mean and unit variance along the
 * `reductionAxes`, followed by scaling with `gamma` and shifted by `beta`.
 * The result of that is returned as the first element
 * of the returned `Array`. The other two elements are the mean and variance,
 * respectively.
 *
 * @param x Input tensor to be normalized.
 * @param gamma Tensor by which to scale the input.
 * @param beta Tensor by which to center the input.
 * @param reductionAxes Axes over which to normalize.
 * @param epsilon Fuzz factor.
 * @returns An `Array` of three `Tensors`:
 *   [normalized tensor, mean of input, variance of input].
 */
function broadcastNormalizeBatchInTraining(
    x: Tensor, gamma: Tensor, beta: Tensor, reductionAxes: number[],
    epsilon = 1e-3): [Tensor, Tensor, Tensor] {
  return tidy(() => {
           const meanAndVariance = tfc.moments(x, reductionAxes);
           const mean = meanAndVariance.mean;
           const variance = meanAndVariance.variance;
           const targetShape: number[] = [];
           for (const axis of math_utils.range(0, x.rank)) {
             if (reductionAxes.indexOf(axis) !== -1) {
               targetShape.push(1);
             } else {
               targetShape.push(x.shape[axis]);
             }
           }
           const broadcastMean = mean.reshape(targetShape);
           const broadcastVariance = variance.reshape(targetShape);
           const broadcastGamma =
               gamma == null ? null : gamma.reshape(targetShape);
           const broadcastBeta =
               beta == null ? null : beta.reshape(targetShape);
           const normed = batchNormalization(
               x, broadcastMean, broadcastVariance, broadcastBeta,
               broadcastGamma, epsilon);
           return [normed, mean, variance];
         }) as [Tensor, Tensor, Tensor];
}

/**
 * Batch normalization for use in training (not inference).
 *
 * @param x Input tensor to be normalized.
 * @param gamma Tensor by which to scale the input.
 * @param beta Tensor by which to center the input.
 * @param reductionAxes Axes over which to normalize.
 * @param epsilon Fuzz factor.
 * @returns An `Array` of three `Tensors`:
 *   [normalized tensor, mean of input, variance of input].
 */
export function normalizeBatchInTraining(
    x: Tensor, gamma: Tensor, beta: Tensor, reductionAxes: number[],
    epsilon = 1e-3): [Tensor, Tensor, Tensor] {
  if (util.arraysEqual(
          reductionAxes.slice().sort(), math_utils.range(0, x.rank - 1))) {
    return regularNormalizeBatchInTraining(
        x, gamma, beta, reductionAxes, epsilon);
  } else {
    return broadcastNormalizeBatchInTraining(
        x, gamma, beta, reductionAxes, epsilon);
  }
}

export declare interface BatchNormalizationLayerArgs extends LayerArgs {
  /**
   * The integer axis that should be normalized (typically the features axis).
   * Defaults to -1.
   *
   * For instance, after a `Conv2D` layer with `data_format="channels_first"`,
   * set `axis=1` in `batchNormalization`.
   */
  axis?: number;

  /**
   * Momentum of the moving average. Defaults to 0.99.
   */
  momentum?: number;

  /**
   * Small float added to the variance to avoid dividing by zero. Defaults to
   * 1e-3.
   */
  epsilon?: number;

  /**
   * If `true`, add offset of `beta` to normalized tensor.
   * If `false`, `beta` is ignored.
   * Defaults to `true`.
   */
  center?: boolean;

  /**
   * If `true`, multiply by `gamma`.
   * If `false`, `gamma` is not used.
   * When the next layer is linear (also e.g. `nn.relu`),
   * this can be disabled since the scaling will be done by the next layer.
   * Defaults to `true`.
   */
  scale?: boolean;

  /**
   * Initializer for the beta weight.
   *  Defaults to 'zeros'.
   */
  betaInitializer?: InitializerIdentifier|Initializer;

  /**
   * Initializer for the gamma weight.
   *  Defaults to `ones`.
   */
  gammaInitializer?: InitializerIdentifier|Initializer;

  /**
   * Initializer for the moving mean.
   * Defaults to `zeros`
   */
  movingMeanInitializer?: InitializerIdentifier|Initializer;

  /**
   * Initializer for the moving variance.
   *  Defaults to 'Ones'.
   */
  movingVarianceInitializer?: InitializerIdentifier|Initializer;

  /**
   * Constraint for the beta weight.
   */
  betaConstraint?: ConstraintIdentifier|Constraint;

  /**
   * Constraint for gamma weight.
   */
  gammaConstraint?: ConstraintIdentifier|Constraint;

  /**
   * Regularizer for the beta weight.
   */
  betaRegularizer?: RegularizerIdentifier|Regularizer;

  /**
   * Regularizer for the gamma weight.
   */
  gammaRegularizer?: RegularizerIdentifier|Regularizer;
}


/**
 * Batch normalization layer (Ioffe and Szegedy, 2014).
 *
 * Normalize the activations of the previous layer at each batch,
 * i.e. applies a transformation that maintains the mean activation
 * close to 0 and the activation standard deviation close to 1.
 *
 * Input shape:
 *   Arbitrary. Use the keyword argument `inputShape` (Array of integers, does
 *   not include the sample axis) when calling the constructor of this class,
 *   if this layer is used as a first layer in a model.
 *
 * Output shape:
 *   Same shape as input.
 *
 * References:
 *   - [Batch Normalization: Accelerating Deep Network Training by Reducing
 * Internal Covariate Shift](https://arxiv.org/abs/1502.03167)
 */
export class BatchNormalization extends Layer {
  /** @nocollapse */
  static className = 'BatchNormalization';
  private readonly axis: number;
  private readonly momentum: number;
  private readonly epsilon: number;
  private readonly center: boolean;
  private readonly scale: boolean;
  private readonly betaInitializer: Initializer;
  private readonly gammaInitializer: Initializer;
  private readonly movingMeanInitializer: Initializer;
  private readonly movingVarianceInitializer: Initializer;
  private readonly betaConstraint: Constraint;
  private readonly gammaConstraint: Constraint;
  private readonly betaRegularizer: Regularizer;
  private readonly gammaRegularizer: Regularizer;
  private gamma: LayerVariable;
  private beta: LayerVariable;
  private movingMean: LayerVariable;
  private movingVariance: LayerVariable;

  constructor(args?: BatchNormalizationLayerArgs) {
    if (args == null) {
      args = {};
    }
    super(args);

    this.supportsMasking = true;
    this.axis = args.axis == null ? -1 : args.axis;
    this.momentum = args.momentum == null ? 0.99 : args.momentum;
    this.epsilon = args.epsilon == null ? 1e-3 : args.epsilon;
    this.center = args.center == null ? true : args.center;
    this.scale = args.scale == null ? true : args.scale;
    this.betaInitializer = getInitializer(args.betaInitializer || 'zeros');
    this.gammaInitializer = getInitializer(args.gammaInitializer || 'ones');
    this.movingMeanInitializer =
        getInitializer(args.movingMeanInitializer || 'zeros');
    this.movingVarianceInitializer =
        getInitializer(args.movingVarianceInitializer || 'ones');
    this.betaConstraint = getConstraint(args.betaConstraint);
    this.gammaConstraint = getConstraint(args.gammaConstraint);
    this.betaRegularizer = getRegularizer(args.betaRegularizer);
    this.gammaRegularizer = getRegularizer(args.gammaRegularizer);
  }

  public build(inputShape: Shape|Shape[]): void {
    inputShape = getExactlyOneShape(inputShape);
    const axis = this.axis >= 0 ? this.axis : (this.axis + inputShape.length);
    const dim = inputShape[axis];
    if (dim == null) {
      throw new ValueError(
          `Axis ${axis} of input tensor should have a defined dimension but ` +
          `the layer received an input with shape ` +
          `${JSON.stringify(inputShape)}.`);
    }
    this.inputSpec =
        [new InputSpec({ndim: inputShape.length, axes: {[axis]: dim}})];
    const shape = [dim];
    if (this.scale) {
      this.gamma = this.addWeight(
          'gamma', shape, null, this.gammaInitializer, this.gammaRegularizer,
          true, this.gammaConstraint);
    }
    if (this.center) {
      this.beta = this.addWeight(
          'beta', shape, null, this.betaInitializer, this.betaRegularizer, true,
          this.betaConstraint);
    }
    this.movingMean = this.addWeight(
        'moving_mean', shape, null, this.movingMeanInitializer, null, false);
    this.movingVariance = this.addWeight(
        'moving_variance', shape, null, this.movingVarianceInitializer, null,
        false);
    this.built = true;
  }

  call(inputs: Tensor|Tensor[], kwargs: Kwargs): Tensor|Tensor[] {
    return tidy(() => {
      const training = kwargs['training'] == null ? false : kwargs['training'];
      const input = getExactlyOneTensor(inputs);
      const inputShape = input.shape;
      const ndim = inputShape.length;
      const reductionAxes = math_utils.range(0, ndim);
      const axis = this.axis >= 0 ? this.axis : (this.axis + ndim);
      reductionAxes.splice(axis, 1);
      const broadcastShape = generic_utils.pyListRepeat(1, ndim);
      broadcastShape[axis] = inputShape[axis];

      const sortedReductionAxes = reductionAxes.slice();
      sortedReductionAxes.sort();
      const needsBroadcasting = !util.arraysEqual(
          sortedReductionAxes, math_utils.range(0, ndim).slice(0, ndim - 1));

      const normalizeInference: () => Tensor = () => {
        if (needsBroadcasting) {
          const broadcastMovingMean =
              this.movingMean.read().reshape(broadcastShape);
          const broadcastMovingVariance =
              this.movingVariance.read().reshape(broadcastShape);
          const broadcastBeta =
              this.center ? this.beta.read().reshape(broadcastShape) : null;
          const broadcastGamma =
              this.scale ? this.gamma.read().reshape(broadcastShape) : null;
          return batchNormalization(
              input, broadcastMovingMean, broadcastMovingVariance,
              broadcastBeta, broadcastGamma, this.epsilon);
        } else {
          return batchNormalization(
              input, this.movingMean.read(), this.movingVariance.read(),
              this.beta == null ? null : this.beta.read(),
              this.gamma == null ? null : this.gamma.read(), this.epsilon);
        }
      };

      if (!training) {
        return normalizeInference();
      }

      const [normedTraining, mean, variance] = normalizeBatchInTraining(
          input, this.gamma.read(), this.beta.read(), reductionAxes,
          this.epsilon);

      const doMovingAverage =
          (variable: LayerVariable, value: Tensor, momentum: number): void => {
            tfc.tidy(() => {
              const decay = 1 - momentum;
              const origValue = variable.read();
              const updateDelta = origValue.sub(value).mul(decay);
              variable.write(origValue.sub(updateDelta));
            });
          };

      // Perform updates to moving mean and moving variance for training.
      // Porting Note: In PyKeras, these updates to `movingMean` and
      //   `movingAverage` are done as a deferred Graph, added to the `Layer`'s
      //   `update`s using the `add_update()` method. Here we do it imperatively
      //   and encapsulate the updates in a function that is invoked
      //   immediately.
      const updateMovingMeanAndVariance = () => {
        doMovingAverage(this.movingMean, mean, this.momentum);
        doMovingAverage(this.movingVariance, variance, this.momentum);
      };
      updateMovingMeanAndVariance();

      return normedTraining;
    });
  }

  getConfig(): serialization.ConfigDict {
    const config: serialization.ConfigDict = {
      axis: this.axis,
      momentum: this.momentum,
      epsilon: this.epsilon,
      center: this.center,
      scale: this.scale,
      betaInitializer: serializeInitializer(this.betaInitializer),
      gammaInitializer: serializeInitializer(this.gammaInitializer),
      movingMeanInitializer: serializeInitializer(this.movingMeanInitializer),
      movingVarianceInitializer:
          serializeInitializer(this.movingVarianceInitializer),
      betaRegularizer: serializeRegularizer(this.betaRegularizer),
      gammaRegularizer: serializeRegularizer(this.gammaRegularizer),
      betaConstraint: serializeConstraint(this.betaConstraint),
      gammaConstraint: serializeConstraint(this.gammaConstraint)
    };
    const baseConfig = super.getConfig();
    Object.assign(config, baseConfig);
    return config;
  }
}
serialization.registerClass(BatchNormalization);
