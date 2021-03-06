'use strict';

const resolve = require('path').resolve;
const basename = require('path').basename;
const sync = require('glob').sync;
const bundleTypes = require('./bundles').bundleTypes;
const moduleTypes = require('./bundles').moduleTypes;
const extractErrorCodes = require('../error-codes/extract-errors');

const exclude = [
  '**/__benchmarks__/**/*.js',
  '**/__tests__/**/*.js',
  '**/__mocks__/**/*.js',
];

const UMD_DEV = bundleTypes.UMD_DEV;
const UMD_PROD = bundleTypes.UMD_PROD;
const NODE_DEV = bundleTypes.NODE_DEV;
const NODE_PROD = bundleTypes.NODE_PROD;
const FB_DEV = bundleTypes.FB_DEV;
const FB_PROD = bundleTypes.FB_PROD;
const RN_DEV = bundleTypes.RN_DEV;
const RN_PROD = bundleTypes.RN_PROD;

const ISOMORPHIC = moduleTypes.ISOMORPHIC;
const RENDERER = moduleTypes.RENDERER;

const errorCodeOpts = {
  errorMapFilePath: 'scripts/error-codes/codes.json',
};

// these are the FBJS modules that are used throughout our bundles
const fbjsModules = [
  'fbjs/lib/warning',
  'fbjs/lib/invariant',
  'fbjs/lib/emptyFunction',
  'fbjs/lib/emptyObject',
  'fbjs/lib/hyphenateStyleName',
  'fbjs/lib/getUnboundedScrollPosition',
  'fbjs/lib/camelizeStyleName',
  'fbjs/lib/containsNode',
  'fbjs/lib/shallowEqual',
  'fbjs/lib/getActiveElement',
  'fbjs/lib/focusNode',
  'fbjs/lib/EventListener',
  'fbjs/lib/memoizeStringOnly',
  'fbjs/lib/ExecutionEnvironment',
  'fbjs/lib/createNodesFromMarkup',
  'fbjs/lib/performanceNow',
];

const devOnlyFilesToStubOut = [
  "'ReactDebugCurrentFrame'",
  "'ReactComponentTreeHook'",
  "'ReactPerf'",
  "'ReactTestUtils'",
];

const legacyModules = [
  'create-react-class',
  'create-react-class/factory',
  'prop-types',
  'prop-types/checkPropTypes',
];

// this function builds up a very niave Haste-like moduleMap
// that works to create up an alias map for modules to link
// up to their actual disk location so Rollup can properly
// bundle them
function createModuleMap(paths, extractErrors, bundleType) {
  const moduleMap = {};

  paths.forEach(path => {
    const files = sync(path, {ignore: exclude});

    files.forEach(file => {
      if (extractErrors) {
        extractErrors(file);
      }
      const moduleName = basename(file, '.js');

      moduleMap[moduleName] = resolve(file);
    });
  });
  // if this is FB, we want to remove ReactCurrentOwner and lowPriorityWarning,
  // so we can handle it with a different case
  if (bundleType === FB_DEV || bundleType === FB_PROD) {
    delete moduleMap.ReactCurrentOwner;
    delete moduleMap.lowPriorityWarning;
  }
  return moduleMap;
}

function getNodeModules(bundleType, moduleType) {
  // rather than adding the rollup node resolve plugin,
  // we can instead deal with the only node module that is used
  // for UMD bundles - object-assign
  switch (bundleType) {
    case UMD_DEV:
    case UMD_PROD:
      return {
        // Bundle object-assign once in the isomorphic React, and then use
        // that from the renderer UMD. Avoids bundling it in both UMDs.
        'object-assign': moduleType === ISOMORPHIC
          ? resolve('./node_modules/object-assign/index.js')
          : resolve('./scripts/rollup/shims/rollup/assign.js'),
        // include the ART package modules directly by aliasing them from node_modules
        'art/modes/current': resolve('./node_modules/art/modes/current.js'),
        'art/modes/fast-noSideEffects': resolve(
          './node_modules/art/modes/fast-noSideEffects.js'
        ),
        'art/core/transform': resolve('./node_modules/art/core/transform.js'),
      };
    case NODE_DEV:
    case NODE_PROD:
    case FB_DEV:
    case FB_PROD:
    case RN_DEV:
    case RN_PROD:
      return {};
  }
}

function ignoreFBModules() {
  return [
    // These are FB-specific aliases to react and react-dom.
    // Don't attempt to bundle them into other bundles.
    'React',
    'ReactDOM',
    // At FB, we don't know them statically:
    'ReactFeatureFlags',
    // In FB bundles, we preserve an inline require to ReactCurrentOwner.
    // See the explanation in FB version of ReactCurrentOwner in www:
    'ReactCurrentOwner',
    'lowPriorityWarning',
  ];
}

function ignoreReactNativeModules() {
  return [
    // This imports NativeMethodsMixin, causing a circular dependency.
    'View',
  ];
}

function getExternalModules(externals, bundleType, moduleType) {
  // external modules tell Rollup that we should not attempt
  // to bundle these modules and instead treat them as
  // external dependencies to the bundle. so for CJS bundles
  // this means having a require("name-of-external-module") at
  // the top of the bundle. for UMD bundles this means having
  // both a require and a global check for them
  let externalModules = externals.slice();
  switch (bundleType) {
    case UMD_DEV:
    case UMD_PROD:
      if (moduleType !== ISOMORPHIC) {
        externalModules.push('react');
      }
      break;
    case NODE_DEV:
    case NODE_PROD:
    case RN_DEV:
    case RN_PROD:
      fbjsModules.forEach(module => externalModules.push(module));
      externalModules.push('object-assign');
      if (moduleType !== ISOMORPHIC) {
        externalModules.push('react');
      }
      break;
    case FB_DEV:
    case FB_PROD:
      fbjsModules.forEach(module => externalModules.push(module));
      externalModules.push('object-assign');
      externalModules.push('ReactCurrentOwner');
      externalModules.push('lowPriorityWarning');
      if (moduleType !== ISOMORPHIC) {
        externalModules.push('React');
        if (externalModules.indexOf('react-dom') > -1) {
          externalModules.push('ReactDOM');
        }
      }
      break;
  }
  return externalModules;
}

function getInternalModules(moduleType) {
  // we tell Rollup where these files are located internally, otherwise
  // it doesn't pick them up and assumes they're external
  let aliases = {
    reactProdInvariant: resolve('./packages/shared/reactProdInvariant.js'),
  };
  if (moduleType === RENDERER) {
    // Renderers bundle the whole reconciler.
    aliases['react-reconciler'] = resolve(
      './packages/react-reconciler/index.js'
    );
  }
  return aliases;
}

function getFbjsModuleAliases(bundleType) {
  switch (bundleType) {
    case UMD_DEV:
    case UMD_PROD:
      // we want to bundle these modules, so we re-alias them to the actual
      // file so Rollup can bundle them up
      const fbjsModulesAlias = {};
      fbjsModules.forEach(fbjsModule => {
        fbjsModulesAlias[fbjsModule] = resolve(`./node_modules/${fbjsModule}`);
      });
      return fbjsModulesAlias;
    case NODE_DEV:
    case NODE_PROD:
    case FB_DEV:
    case FB_PROD:
    case RN_DEV:
    case RN_PROD:
      // for FB we don't want to bundle the above modules, instead keep them
      // as external require() calls in the bundle
      return {};
  }
}

function replaceFbjsModuleAliases(bundleType) {
  switch (bundleType) {
    case FB_DEV:
    case FB_PROD:
      // Haste at FB doesn't currently allow case sensitive names,
      // and product code already uses "React". In the future,
      // we will either allow both variants or migrate to lowercase.
      return {
        "'react'": "'React'",
        "'react-dom'": "'ReactDOM'",
      };
    default:
      return {};
  }
}

const devOnlyModuleStub = `'${resolve('./scripts/rollup/shims/rollup/DevOnlyStubShim.js')}'`;

function replaceDevOnlyStubbedModules(bundleType) {
  switch (bundleType) {
    case UMD_DEV:
    case NODE_DEV:
    case FB_DEV:
    case RN_DEV:
    case RN_PROD:
      return {};
    case FB_PROD:
    case UMD_PROD:
    case NODE_PROD:
      const devOnlyModuleAliases = {};
      devOnlyFilesToStubOut.forEach(devOnlyModule => {
        devOnlyModuleAliases[devOnlyModule] = devOnlyModuleStub;
      });
      return devOnlyModuleAliases;
  }
}

function replaceLegacyModuleAliases(bundleType) {
  switch (bundleType) {
    case UMD_DEV:
    case UMD_PROD:
      const modulesAlias = {};
      legacyModules.forEach(legacyModule => {
        const modulePath = legacyModule.includes('/')
          ? legacyModule
          : `${legacyModule}/index`;
        const resolvedPath = resolve(`./node_modules/${modulePath}`);
        modulesAlias[`'${legacyModule}'`] = `'${resolvedPath}'`;
      });
      return modulesAlias;
    case NODE_DEV:
    case NODE_PROD:
    case FB_DEV:
    case FB_PROD:
    case RN_DEV:
    case RN_PROD:
      return {};
  }
}

function replaceBundleStubModules(bundleModulesToStub) {
  const stubbedModules = {};

  if (Array.isArray(bundleModulesToStub)) {
    bundleModulesToStub.forEach(module => {
      stubbedModules[`'${module}'`] = devOnlyModuleStub;
    });
  }

  return stubbedModules;
}

function getAliases(paths, bundleType, moduleType, extractErrors) {
  return Object.assign(
    createModuleMap(
      paths,
      extractErrors && extractErrorCodes(errorCodeOpts),
      bundleType
    ),
    getInternalModules(moduleType),
    getNodeModules(bundleType, moduleType),
    getFbjsModuleAliases(bundleType)
  );
}

function replaceFeatureFlags(featureFlags) {
  if (!featureFlags) {
    return {};
  }
  return {
    "'ReactFeatureFlags'": `'${resolve(featureFlags)}'`,
  };
}

function getDefaultReplaceModules(
  bundleType,
  bundleModulesToStub,
  featureFlags
) {
  return Object.assign(
    {},
    replaceFbjsModuleAliases(bundleType),
    replaceDevOnlyStubbedModules(bundleType),
    replaceLegacyModuleAliases(bundleType),
    replaceBundleStubModules(bundleModulesToStub),
    replaceFeatureFlags(featureFlags)
  );
}

function getExcludedHasteGlobs() {
  return exclude;
}

module.exports = {
  getExcludedHasteGlobs,
  getDefaultReplaceModules,
  getAliases,
  ignoreFBModules,
  ignoreReactNativeModules,
  getExternalModules,
};
