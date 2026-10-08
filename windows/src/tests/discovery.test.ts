import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preferredVenue } from '../main/discovery';

test('顶会来源识别会排除会议名称中包含的 workshop proceedings', () => {
  assert.equal(preferredVenue('2025 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)'), 'CVPR');
  assert.equal(preferredVenue('Medical Image Computing and Computer Assisted Intervention (MICCAI)'), 'MICCAI');
  assert.equal(preferredVenue('2025 IEEE/CVF Conference on Computer Vision and Pattern Recognition Workshops (CVPRW)'), null);
  assert.equal(preferredVenue('MICCAI Workshop on Image-Guided Procedures'), null);
  assert.equal(preferredVenue('Some unrelated workshop'), null);
});
