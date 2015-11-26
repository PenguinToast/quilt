all:
	# A Go build bug causes it to behave badly with symlinks.
	cd -P . && go build . && go build -o ./minion/minion ./minion

install:
	cd -P . && go install ./...

proto:
	cd -P minion/proto &&  protoc proto.proto --go_out=plugins=grpc:.

format:
	gofmt -w -s .

docker:
	cd -P minion && CGO_ENABLED=0 go build . && docker build -t quay.io/netsys/di-minion .
