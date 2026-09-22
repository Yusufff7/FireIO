import {MkvDemuxModule} from '../src';

jest.mock('../src/turbo-modules/MkvDemuxModule');

describe('Template Turbomodule library tests', () => {
  it('Sample Test Case', () => {
    expect(MkvDemuxModule.getMajorVersion()).toBe(1);
  });
});
