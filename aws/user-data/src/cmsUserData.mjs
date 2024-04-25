import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient,
    PutCommand,
    GetCommand,
    UpdateCommand
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME || 'CmsUserData';
const MAX_FAVORITES = 50;

function successResponse(sourceALB, body) {
    body.success = true;
    body.message = "success";

    if (sourceALB) {
        // response for ALB
        return {
            statusCode: '200',
            statusDescription: '200 OK',
            isBase64Encoded: false,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body)
        };
    } else {
        // response for API Gateway
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body)
        };
    }
}

function failResponse(sourceALB, statusCode, message) {
    let body = {
        success: false,
        message: message
    };

    const headers = {
        'Content-Type': 'application/json',
    };

    if (sourceALB) {
        // response for ALB
        return {
            statusCode: statusCode,
            statusDescription: statusCode + " FAIL",
            isBase64Encoded: false,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body)
        };
    } else {
        // response for API Gateway
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body)
        };
    }
}

export const handler = async (event) => {
    // console.log('Received event:', JSON.stringify(event, null, 2));
    let sourceALB = !!!event.resource;
    let body = {
        success: true,
        message: ""
    };

    let method = event.queryStringParameters.method || "GET";
    method = method.toUpperCase();
    let site = event.queryStringParameters.site || "";
    let userId = event.queryStringParameters.userId || "";

    if (!site) {
        throw new Error('site parameter is missing');
    }
    if (!userId) {
        throw new Error('userId parameter is missing');
    }

    let limit, type, documentId, timestamp, record;

    try {

        switch (method) {
            case 'GET':
                type = event.queryStringParameters.type || "";
                limit = event.queryStringParameters.limit || 99999;
                if (limit == -1) {
                    limit = 99999;
                }

                if (type) {
                    type = type.toLowerCase();

                    record = await dynamo.send(
                        new GetCommand({
                            TableName: TABLE_NAME,
                            Key: {
                                site: site,
                                userId: userId
                            },
                            ProjectionExpression: `${type}, dt`
                        })
                    );

                    if (record && record.Item) {
                        body[type] = record.Item[type].slice(0 - limit);
                        body.dt = record.Item.dt || "";
                        if (type === "favorite") {
                            body.favoriteCount = record.Item[type].length;
                        }
                    } else {
                        body[type] = [];
                        body.dt = "";
                    }
                } else {
                    record = await dynamo.send(
                        new GetCommand({
                            TableName: TABLE_NAME,
                            Key: {
                                site: site,
                                userId: userId
                            }
                        })
                    );

                    if (record && record.Item) {
                        for (const [key, value] of Object.entries(record.Item)) {
                            if (Array.isArray(record.Item[key])) {
                                body[key] = record.Item[key].slice(0 - limit);
                                if (key === "favorite") {
                                    body.favoriteCount = body[key].length;
                                }
                            } else {
                                body[key] = record.Item[key];
                            }
                        }
                        body.dt = record.Item.dt || "";
                    } else {
                        body.favorite = [];
                        body.viewed = [];
                        body.dt = "";
                    }
                }

                break;

            case 'POST':
                timestamp = event.queryStringParameters.dt || "";

                if (!timestamp) {
                    throw new Error('timestamp parameter is missing');
                }

                let requestBody = JSON.parse(event.body);

                let item = {
                    userId: userId,
                    site: site,
                    dt: timestamp,
                    favorite: requestBody.favorite || [],
                    viewed: requestBody.viewed || []
                }

                record = await dynamo.send(
                    new PutCommand({
                        TableName: TABLE_NAME,
                        Item: item,
                        ReturnValues: 'NONE'
                    })
                );
                body.dt = timestamp;
                body.favoriteCount = item.favorite.length;

                break;

            case 'PUT':
                type = event.queryStringParameters.type || "";
                documentId = event.queryStringParameters.id || "";
                timestamp = event.queryStringParameters.dt || "";

                if (!type) {
                    throw new Error('type parameter is missing');
                }
                if (!documentId) {
                    throw new Error('id (documentId) parameter is missing');
                }
                if (!timestamp) {
                    throw new Error('timestamp parameter is missing');
                }

                type = type.toLowerCase();

                record = await dynamo.send(
                    new GetCommand({
                        TableName: TABLE_NAME,
                        Key: {
                            site: site,
                            userId: userId
                        },
                        ProjectionExpression: `dt, ${type}`
                    })
                );

                if (record && record.Item) {
                    // user record exists. update it
                    if (!!record.Item[type]) {
                        let index = -1;
                        if (Array.isArray(record.Item[type])) {
                            for (let i = 0; i < record.Item[type].length; i++) {
                                if (record.Item[type][i].id === documentId) {
                                    index = i;
                                    break;
                                }
                            }
                        }

                        if (index > -1) {
                            // array contains the entry at {index}
                            delete record.Item[type][index];
                            record.Item[type].push({
                                id: documentId,
                                dt: timestamp
                            });

                            if (type === "favorite") {
                                record.Item[type] = record.Item[type].slice(0 - MAX_FAVORITES);
                            }

                        } else {
                            // array does not contain the entry. add it
                            record.Item[type].push({
                                id: documentId,
                                dt: timestamp
                            });
                        }

                        record = await dynamo.send(
                            new UpdateCommand({
                                TableName: TABLE_NAME,
                                Key: {
                                    site: site,
                                    userId: userId
                                },
                                UpdateExpression: 'SET dt = :timestamp, #thisList = :newList',
                                ExpressionAttributeNames: {
                                    '#thisList': type
                                },
                                ExpressionAttributeValues: {
                                    ':timestamp': timestamp,
                                    ':newList': record.Item[type]
                                },
                                ReturnValues: 'NONE'
                            })
                        );
                    } else {
                        // the list does not exist. create it
                        await dynamo.send(
                            new UpdateCommand({
                                TableName: TABLE_NAME,
                                Key: {
                                    site: site,
                                    userId: userId
                                },
                                UpdateExpression: 'SET dt = :timestamp, #thisList = :newList',
                                ExpressionAttributeNames: {
                                    '#thisList': type
                                },
                                ExpressionAttributeValues: {
                                    ':timestamp': timestamp,
                                    ':newList': [{
                                        id: documentId,
                                        dt: timestamp
                                    }]
                                },
                                ReturnValues: 'NONE'
                            })
                        );
                    }

                } else {
                    // no record yet for this site/user so create it
                    let item = {
                        userId: userId,
                        site: site,
                        favorite: [],
                        viewed: [],
                        dt: timestamp
                    }

                    item[type] = [{
                        id: documentId,
                        dt: timestamp
                    }];

                    await dynamo.send(
                        new PutCommand({
                            TableName: TABLE_NAME,
                            Item: item,
                            ReturnValues: 'NONE'
                        })
                    );
                }

                body.dt = timestamp;

                break;

            case 'DELETE':
                type = event.queryStringParameters.type || "";
                documentId = event.queryStringParameters.id || "";
                timestamp = event.queryStringParameters.dt || "";

                if (!type) {
                    throw new Error('type parameter is missing');
                }
                if (!documentId) {
                    throw new Error('id (documentId) parameter is missing');
                }
                if (!timestamp) {
                    throw new Error('dt (timestamp) parameter is missing');
                }

                type = type.toLowerCase();

                record = await dynamo.send(
                    new GetCommand({
                        TableName: TABLE_NAME,
                        Key: {
                            site: site,
                            userId: userId
                        },
                        ProjectionExpression: `${type}, dt`
                    })
                );

                body.dt = record.Item.dt;

                if (record && record.Item && record.Item[type] && Array.isArray(record.Item[type])) {
                    for (let i = 0; i < record.Item[type].length; i++) {
                        if (record.Item[type][i].id === documentId) {
                            await dynamo.send(
                                new UpdateCommand({
                                    TableName: TABLE_NAME,
                                    Key: {
                                        site: site,
                                        userId: userId
                                    },
                                    UpdateExpression: `SET dt = :timestamp REMOVE ${type}[${i}]`,
                                    ExpressionAttributeValues: {
                                        ':timestamp': timestamp,
                                    },
                                    ReturnValues: 'NONE'
                                })
                            );
                            body.dt = timestamp;
                            break;
                        }
                    }
                }

                break;

            default:
                throw new `Unsupported method "${event.httpMethod}"`;
        }
    } catch (err) {
        return failResponse(sourceALB, '400', err.message);
    } finally {
    }

    // console.log(`sourceALB: ${sourceALB} body: ${JSON.stringify(body, null, 2)}`);
    return successResponse(sourceALB, body);
};
