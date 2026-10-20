"""Public errors preserved by the host tool dialog."""


class RPCError(RuntimeError):
    def __init__(self, message, *, code=None, details=None):
        super().__init__(message)
        self.code, self.details = code, details

    def payload(self):
        return {"error": str(self),
                **({"code": self.code} if self.code is not None else {}),
                **({"details": self.details} if self.details is not None else {})}


class OperationError(RPCError):
    """A service completed and rejected its request; response stays available."""
    def __init__(self, operation, interface, response):
        from rosidl_runtime_py.convert import message_to_ordereddict
        self.operation, self.interface, self.response = operation, interface, response
        super().__init__(response.message, code="operation_rejected", details={
            "operation": operation, "type": interface,
            "response": message_to_ordereddict(response),
        })
