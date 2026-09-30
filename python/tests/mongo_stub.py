"""Small in-memory resource fixture that enforces the Mongo find wire contract."""

from copy import deepcopy

MISSING = object()


def field(document, key):
    value = document
    for part in key.split("."):
        if not isinstance(value, dict) or part not in value:
            return MISSING
        value = value[part]
    return value


def matches(document, query):
    for key, condition in query.items():
        if key == "$or":
            if not any(matches(document, clause) for clause in condition):
                return False
            continue
        value = field(document, key)
        if isinstance(condition, dict):
            for operator, operand in condition.items():
                if operator == "$exists":
                    valid = (value is not MISSING) == operand
                elif operator == "$in":
                    valid = value in operand
                elif operator == "$gt":
                    valid = value is not MISSING and value > operand
                else:
                    raise AssertionError(f"Unsupported query operator: {operator}")
                if not valid:
                    return False
        elif value != condition:
            return False
    return True


class MongoStub:
    def __init__(self, records):
        self.records = deepcopy(records)
        self.calls = []

    def __call__(self, resource, body):
        assert resource == "mongo"
        assert body["collection"] == "source_files"
        assert not ({"sort", "limit", "projection"} & body.keys()), "Use Mongo options"
        self.calls.append(deepcopy(body))
        selected = [record for record in self.records if matches(record, body.get("query", {}))]
        if body["action"] == "count":
            return len(selected)
        if body["action"] == "find":
            options = body.get("options", {})
            assert isinstance(options.get("sort", {}), dict)
            for key, direction in reversed(list(options.get("sort", {}).items())):
                selected.sort(key=lambda item: field(item, key), reverse=direction < 0)
            return deepcopy(selected[:options.get("limit", 1000)])
        if body["action"] == "insertOne":
            self.records.append(deepcopy(body["doc"]))
            return {"insertedId": "inserted"}
        if body["action"] == "updateOne":
            if not selected:
                return {"matchedCount": 0, "modifiedCount": 0}
            record = selected[0]
            record.update(deepcopy(body["update"].get("$set", {})))
            for key in body["update"].get("$unset", {}):
                record.pop(key, None)
            return {"matchedCount": 1, "modifiedCount": 1}
        raise AssertionError(f"Unsupported Mongo action: {body['action']}")
