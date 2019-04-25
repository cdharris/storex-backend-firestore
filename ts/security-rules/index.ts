import * as flatten from 'lodash/flatten'
import * as some from 'lodash/some'
import { StorageRegistry, CollectionDefinition } from "@worldbrain/storex";
import { StorageModuleInterface, StorageModuleConfig, AccessType, AccessRules } from "@worldbrain/storex-pattern-modules";
import { MatchNode, AllowOperation } from "./ast";

type BaseInfo = {}
type ModuleInfo = BaseInfo & { moduleName : string, storageRegistry : StorageRegistry }
type CollectionInfo = ModuleInfo & { collectionName : string, accessRules : AccessRules }

const FIELD_TYPE_MAP = {
    boolean: 'bool',
    string: 'string',
    int: 'number',
    float: 'float',
}

const ACCESS_TYPE_MAP : { [Type in AccessType] : AllowOperation} = {
    list: 'list',
    read: 'get',
    create: 'create',
    update: 'update',
    delete: 'delete',
}

export function generateRulesAstFromStorageModules(
    modules : { [name : string] : StorageModuleInterface },
    options : { storageRegistry : StorageRegistry }) : MatchNode
{
    const moduleNodes = flatten(Object.entries(modules).map(([moduleName, module]) => generateModuleNode(module.getConfig(), {
        ...options,
        moduleName
    })))

    const rootNode : MatchNode = {
        type: 'match',
        path: '/databases/{database}/documents',
        content: moduleNodes
    }
    return rootNode
}

export function generateModuleNode(module : StorageModuleConfig, options : ModuleInfo ) : MatchNode[] {
    if (!module.accessRules) {
        return []
    }

    return Object.keys(module.collections)
        .map((collectionName) =>
            generateCollectionNode(options.storageRegistry.collections[collectionName], { ...options, collectionName, accessRules: module.accessRules })
        )
        .filter(node => !!node)
}

export function generateCollectionNode(collection : CollectionDefinition, options : CollectionInfo ) : MatchNode | null {
    const pkField = collection.fields[collection.pkIndex as string]
    const pkKey = pkField.type !== 'auto-pk' ? collection.pkIndex as string : options.collectionName

    const { root: rootNode, inner: collectionNode } = makeEmptyCollectionNode(collection, { ...options, pkKey })

    const accessTypes : AccessType[] = ['list', 'read', 'create', 'update', 'delete']
    for (const accessType of accessTypes) {
        const expressions : string[] = []
        if (accessType === 'create' || accessType === 'update' || accessType === 'delete') {
            const ownershipCheck = generateOwnershipCheck(collection, { ...options, accessType })
            if (ownershipCheck) {
                expressions.push(ownershipCheck)
            }

            const permissionChecks = generatePermissionChecks(collection, { ...options, accessType }).join(' && ')
            if (permissionChecks) {
                expressions.push(permissionChecks)
            }
        }
        if (expressions.length && (accessType === 'create' || accessType === 'update')) {
            const typeChecks = generateFieldTypeChecks(collection, options).join(' && ')
            if (typeChecks.length) {
                expressions.unshift(typeChecks)
            }
        }

        if (expressions.length) {
            collectionNode.content.push({
                type: 'allow',
                operations: [ACCESS_TYPE_MAP[accessType]],
                condition: expressions.join(' && ')
            })
        }
    }

    return rootNode
}

function makeEmptyCollectionNode(collection : CollectionDefinition, options: CollectionInfo & { pkKey : string }): { root: MatchNode, inner: MatchNode } {
    const groupKeys = (collection.groupBy || []).map(group => group.key)
    const keys = [...groupKeys, options.pkKey]
    let inner : MatchNode = {
        type: 'match',
        path: `/${options.collectionName}/{${keys.shift()}}`,
        content: []
    }
    const root = inner
    for (const group of collection.groupBy || []) {
        const childNode : MatchNode = {
            type: 'match',
            path: `/${group.subcollectionName}/{${keys.shift()}}`,
            content: []
        }
        inner.content.push(childNode)
        inner = childNode
    }
    return { root, inner }
}

function generateFieldTypeChecks(collection : CollectionDefinition, options : CollectionInfo) : string[] {
    const checks : string[] = []
    for (const [fieldName, fieldConfig] of Object.entries(collection.fields)) {
        if (fieldConfig.type === 'auto-pk' || fieldName === collection.pkIndex) {
            continue
        }

        if (isGroupKey(fieldName, { collection })) {
            continue
        }

        const firestoreFieldType = FIELD_TYPE_MAP[fieldConfig.type]
        if (!firestoreFieldType) {
            throw new Error(`Could not map type ${fieldConfig.type} of ${options.collectionName}.${fieldName} to Firestore type`)
        }

        let check = `resource.data.${fieldName} is ${firestoreFieldType}`
        if (fieldConfig.optional) {
            check = `(!('${fieldName}' in request.resource.data.keys()) || ${check})`
        }
        checks.push(check)
    }
    return checks
}

function generateOwnershipCheck(collection : CollectionDefinition, options : CollectionInfo & { accessType : AccessType }) : string | null {
    const ownershipRule = options.accessRules.ownership && options.accessRules.ownership[options.collectionName]
    if (!ownershipRule) {
        return null
    }

    const accessTypeMatches = ownershipRule.access !== 'full' && ownershipRule.access.indexOf(options.accessType) >= 0
    if (!accessTypeMatches) {
        return null
    }

    const fieldIsPathParam = collection.pkIndex === ownershipRule.field
    const fieldIsGroupKey = isGroupKey(ownershipRule.field, { collection })
    const rhs = fieldIsPathParam || fieldIsGroupKey ? ownershipRule.field : `resource.data.${ownershipRule.field}`
    return `request.auth.uid === ${rhs}`
}

function generatePermissionChecks(collection : CollectionDefinition, options : CollectionInfo & { accessType : AccessType }) : string[] {
    const permissionRules = options.accessRules.permissions && options.accessRules.permissions[options.collectionName]
    if (!permissionRules) {
        return []
    }

    const accessTypeRule = permissionRules[options.accessType]
    if (!accessTypeRule) {
        return []
    }

    return [accessTypeRule.rule as string]
}

function isGroupKey(key : string, options : { collection : CollectionDefinition }) {
    return some(options.collection.groupBy || [], group => group.key === key)
}