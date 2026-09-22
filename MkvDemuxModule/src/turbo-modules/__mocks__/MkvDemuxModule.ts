function identityFunction<T>(value: T): T {
  return value;
}
export default {
  getConstants: () => ({
    const1: true,
    const2: 375,
    const3: 'something',
  }),
  voidFunc: () => ({}),
  getBool: identityFunction,
  getNumber: identityFunction,
  getString: identityFunction,
  getArray: identityFunction,
  getArrayBuffer: identityFunction,
  getObject: identityFunction,
  getValue: identityFunction,
  getValueWithCallback: (callback: any) => {
    callback('value from callback!');
  },
  getValueWithPromise: (error: boolean) => {
    if (error) {
      return Promise.reject('intentional promise rejection');
    } else {
      return Promise.resolve('result!');
    }
  },
  getMajorVersion: () => 1,
  getMinorVersion: () => 0,
  getPatchVersion: () => 0,
};
