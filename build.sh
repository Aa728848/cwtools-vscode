#!/bin/bash

dotnet tool restore
# Ensure git submodules (cwtools) are available when not using a local override
git submodule update --init --recursive
dotnet run --project build -- -t $@