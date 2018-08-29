import { A } from '@ember/array';
import { Promise } from 'rsvp';
import { assert, warn } from '@ember/debug';

import { _bind, _guard, _objectIsAlive, guardDestroyedStore } from './common';

import { normalizeResponseHelper } from './serializer-response';
import { serializerForAdapter } from './serializers';

function payloadIsNotBlank(adapterPayload) {
  if (Array.isArray(adapterPayload)) {
    return true;
  } else {
    return Object.keys(adapterPayload || {}).length;
  }
}

export function _find(adapter, store, modelClass, id, internalModel, options) {
  let snapshot = internalModel.createSnapshot(options);
  let { modelName } = internalModel;
  let promise = Promise.resolve().then(() => {
    return adapter.findRecord(store, modelClass, id, snapshot);
  });
  let label = `DS: Handle Adapter#findRecord of '${modelName}' with id: '${id}'`;

  promise = guardDestroyedStore(promise, store, label);

  return promise.then(
    adapterPayload => {
      assert(
        `You made a 'findRecord' request for a '${modelName}' with id '${id}', but the adapter's response did not have any data`,
        payloadIsNotBlank(adapterPayload)
      );
      let serializer = serializerForAdapter(store, adapter, modelName);
      let payload = normalizeResponseHelper(
        serializer,
        store,
        modelClass,
        adapterPayload,
        id,
        'findRecord'
      );
      assert(
        `Ember Data expected the primary data returned from a 'findRecord' response to be an object but instead it found an array.`,
        !Array.isArray(payload.data)
      );

      warn(
        `You requested a record of type '${modelName}' with id '${id}' but the adapter returned a payload with primary data having an id of '${
          payload.data.id
        }'. Use 'store.findRecord()' when the requested id is the same as the one returned by the adapter. In other cases use 'store.queryRecord()' instead https://emberjs.com/api/data/classes/DS.Store.html#method_queryRecord`,
        payload.data.id === id,
        {
          id: 'ds.store.findRecord.id-mismatch',
        }
      );

      return store._push(payload);
    },
    error => {
      internalModel.notFound();
      if (internalModel.isEmpty()) {
        internalModel.unloadRecord();
      }

      throw error;
    },
    `DS: Extract payload of '${modelName}'`
  );
}

export function _findMany(adapter, store, modelName, ids, internalModels) {
  let snapshots = A(internalModels).invoke('createSnapshot');
  let modelClass = store.modelFor(modelName); // `adapter.findMany` gets the modelClass still
  let promise = adapter.findMany(store, modelClass, ids, snapshots);
  let label = `DS: Handle Adapter#findMany of '${modelName}'`;

  if (promise === undefined) {
    throw new Error('adapter.findMany returned undefined, this was very likely a mistake');
  }

  promise = guardDestroyedStore(promise, store, label);

  return promise.then(
    adapterPayload => {
      assert(
        `You made a 'findMany' request for '${modelName}' records with ids '[${ids}]', but the adapter's response did not have any data`,
        payloadIsNotBlank(adapterPayload)
      );
      let serializer = serializerForAdapter(store, adapter, modelName);
      let payload = normalizeResponseHelper(
        serializer,
        store,
        modelClass,
        adapterPayload,
        null,
        'findMany'
      );
      return store._push(payload);
    },
    null,
    `DS: Extract payload of ${modelName}`
  );
}

function ensureInverseRelationshipDataOnHasManyResponse(
  store,
  payload,
  leftHandSideRelationshipModel,
  relationship
) {
  if (payload.data.length === 0) {
    return payload;
  }

  let inverseRelationshipInfo = getInverseRelationshipInfo(
    store,
    leftHandSideRelationshipModel,
    relationship
  );
  if (inverseRelationshipInfo) {
    let relationshipIdentifier = buildInverseRelationshipIdentifier(
      inverseRelationshipInfo,
      leftHandSideRelationshipModel,
      relationship
    );

    payload.data.forEach(record => {
      pushInverseRelationshipInfo(store, record, relationshipIdentifier);
    });
  }

  return payload;
}

// TODO: should we modify the payload or use the store._relationshipsPayload manager?
function ensureInverseRelationshipDataOnBelongsToResponse(
  store,
  payload,
  leftHandSideRelationshipModel,
  relationship
) {
  let inverseRelationshipInfo = getInverseRelationshipInfo(
    store,
    leftHandSideRelationshipModel,
    relationship
  );
  if (inverseRelationshipInfo) {
    let relationshipIdentifier = buildInverseRelationshipIdentifier(
      inverseRelationshipInfo,
      leftHandSideRelationshipModel,
      relationship
    );
    pushInverseRelationshipInfo(store, payload.data, relationshipIdentifier);
  }
  return payload;
}

function getInverseRelationshipInfo(store, leftHandSideRelationshipModel, relationship) {
  const { modelName: parentModelName } = leftHandSideRelationshipModel;

  let info = store._relationshipsPayloads.getRelationshipInfo(
    parentModelName,
    relationship.meta.name
  );

  return info.hasInverse ? info : null;
}

function buildInverseRelationshipIdentifier(
  inverseRelationshipInfo,
  leftHandSideRelationshipModel
) {
  const { modelName: parentModelName, id: parentModelID } = leftHandSideRelationshipModel;

  let relationshipInfo = {
    id: parentModelID,
    type: parentModelName,
  };

  if (inverseRelationshipInfo.rhs_relationshipMeta.kind === 'hasMany') {
    relationshipInfo = [relationshipInfo];
  }

  return {
    [inverseRelationshipInfo.rhs_relationshipName]: {
      data: relationshipInfo,
    },
  };
}

function pushInverseRelationshipInfo(store, jsonApiDoc, relationshipIdentifier) {
  store._relationshipsPayloads.push(jsonApiDoc.type, jsonApiDoc.id, relationshipIdentifier);
}

export function _findHasMany(adapter, store, internalModel, link, relationship) {
  let snapshot = internalModel.createSnapshot();
  let modelClass = store.modelFor(relationship.type);
  let promise = adapter.findHasMany(store, snapshot, link, relationship);
  let label = `DS: Handle Adapter#findHasMany of '${internalModel.modelName}' : '${
    relationship.type
  }'`;

  promise = guardDestroyedStore(promise, store, label);
  promise = _guard(promise, _bind(_objectIsAlive, internalModel));

  return promise.then(
    adapterPayload => {
      assert(
        `You made a 'findHasMany' request for a ${internalModel.modelName}'s '${
          relationship.key
        }' relationship, using link '${link}' , but the adapter's response did not have any data`,
        payloadIsNotBlank(adapterPayload)
      );
      let serializer = serializerForAdapter(store, adapter, relationship.type);
      let payload = normalizeResponseHelper(
        serializer,
        store,
        modelClass,
        adapterPayload,
        null,
        'findHasMany'
      );

      payload = ensureInverseRelationshipDataOnHasManyResponse(
        store,
        payload,
        internalModel,
        relationship
      );

      let internalModelArray = store._push(payload);

      internalModelArray.meta = payload.meta;
      return internalModelArray;
    },
    null,
    `DS: Extract payload of '${internalModel.modelName}' : hasMany '${relationship.type}'`
  );
}

export function _findBelongsTo(adapter, store, internalModel, link, relationship) {
  let snapshot = internalModel.createSnapshot();
  let modelClass = store.modelFor(relationship.type);
  let promise = adapter.findBelongsTo(store, snapshot, link, relationship);
  let label = `DS: Handle Adapter#findBelongsTo of ${internalModel.modelName} : ${
    relationship.type
  }`;

  promise = guardDestroyedStore(promise, store, label);
  promise = _guard(promise, _bind(_objectIsAlive, internalModel));

  return promise.then(
    adapterPayload => {
      let serializer = serializerForAdapter(store, adapter, relationship.type);
      let payload = normalizeResponseHelper(
        serializer,
        store,
        modelClass,
        adapterPayload,
        null,
        'findBelongsTo'
      );

      if (!payload.data) {
        return null;
      }

      payload = ensureInverseRelationshipDataOnBelongsToResponse(
        store,
        payload,
        internalModel,
        relationship
      );

      return store._push(payload);
    },
    null,
    `DS: Extract payload of ${internalModel.modelName} : ${relationship.type}`
  );
}

export function _findAll(adapter, store, modelName, sinceToken, options) {
  let modelClass = store.modelFor(modelName); // adapter.findAll depends on the class
  let recordArray = store.peekAll(modelName);
  let snapshotArray = recordArray._createSnapshot(options);
  let promise = Promise.resolve().then(() =>
    adapter.findAll(store, modelClass, sinceToken, snapshotArray)
  );
  let label = 'DS: Handle Adapter#findAll of ' + modelClass;

  promise = guardDestroyedStore(promise, store, label);

  return promise.then(
    adapterPayload => {
      assert(
        `You made a 'findAll' request for '${modelName}' records, but the adapter's response did not have any data`,
        payloadIsNotBlank(adapterPayload)
      );
      let serializer = serializerForAdapter(store, adapter, modelName);
      let payload = normalizeResponseHelper(
        serializer,
        store,
        modelClass,
        adapterPayload,
        null,
        'findAll'
      );

      store._push(payload);
      store._didUpdateAll(modelName);

      return recordArray;
    },
    null,
    'DS: Extract payload of findAll ${modelName}'
  );
}

export function _query(adapter, store, modelName, query, recordArray, options) {
  let modelClass = store.modelFor(modelName); // adapter.query needs the class

  let promise;
  let createRecordArray =
    adapter.query.length > 3 ||
    (adapter.query.wrappedFunction && adapter.query.wrappedFunction.length > 3);

  if (createRecordArray) {
    recordArray =
      recordArray || store.recordArrayManager.createAdapterPopulatedRecordArray(modelName, query);
    promise = Promise.resolve().then(() =>
      adapter.query(store, modelClass, query, recordArray, options)
    );
  } else {
    promise = Promise.resolve().then(() => adapter.query(store, modelClass, query));
  }

  let label = `DS: Handle Adapter#query of ${modelName}`;
  promise = guardDestroyedStore(promise, store, label);

  return promise.then(
    adapterPayload => {
      let serializerToken = heimdall.start('initial-serializerFor-lookup');
      let serializer = serializerForAdapter(store, adapter, modelName);
      heimdall.stop(serializerToken);
      let normalizeToken = heimdall.start('finders#_query::normalizeResponseHelper');
      let payload = normalizeResponseHelper(
        serializer,
        store,
        modelClass,
        adapterPayload,
        null,
        'query'
      );
      heimdall.stop(normalizeToken);
      let internalModels = store._push(payload);

      assert(
        'The response to store.query is expected to be an array but it was a single record. Please wrap your response in an array or use `store.queryRecord` to query for a single record.',
        Array.isArray(internalModels)
      );
      if (recordArray) {
        recordArray._setInternalModels(internalModels, payload);
      } else {
        recordArray = store.recordArrayManager.createAdapterPopulatedRecordArray(
          modelName,
          query,
          internalModels,
          payload
        );
      }

      return recordArray;
    },
    null,
    `DS: Extract payload of query ${modelName}`
  );
}

export function _queryRecord(adapter, store, modelName, query, options) {
  let modelClass = store.modelFor(modelName); // adapter.queryRecord needs the class
  let promise = Promise.resolve().then(() =>
    adapter.queryRecord(store, modelClass, query, options)
  );

  let label = `DS: Handle Adapter#queryRecord of ${modelName}`;
  promise = guardDestroyedStore(promise, store, label);

  return promise.then(
    adapterPayload => {
      let serializer = serializerForAdapter(store, adapter, modelName);
      let payload = normalizeResponseHelper(
        serializer,
        store,
        modelClass,
        adapterPayload,
        null,
        'queryRecord'
      );

      assert(
        `Expected the primary data returned by the serializer for a 'queryRecord' response to be a single object or null but instead it was an array.`,
        !Array.isArray(payload.data),
        {
          id: 'ds.store.queryRecord-array-response',
        }
      );

      return store._push(payload);
    },
    null,
    `DS: Extract payload of queryRecord ${modelName}`
  );
}
