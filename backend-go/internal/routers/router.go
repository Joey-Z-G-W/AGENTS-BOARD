package routers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	"agents-board/backend-go/internal/api/generated"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/gin-gonic/gin"
	ginmiddleware "github.com/oapi-codegen/gin-middleware"
)

func Validator(authentication openapi3filter.AuthenticationFunc) (gin.HandlerFunc, error) {
	specification, err := generated.GetSwagger()
	if err != nil {
		return nil, err
	}
	if err := specification.Validate(context.Background()); err != nil {
		return nil, err
	}
	validator := ginmiddleware.OapiRequestValidatorWithOptions(specification, &ginmiddleware.Options{
		SilenceServersWarning: true,
		Options: openapi3filter.Options{AuthenticationFunc: func(ctx context.Context, input *openapi3filter.AuthenticationInput) error {
			err := errors.New("authentication is not configured")
			if authentication != nil {
				err = authentication(ctx, input)
			}
			if err != nil {
				if request := ginmiddleware.GetGinContext(ctx); request != nil {
					request.Set("board.authentication-failed", true)
				}
			}
			return err
		}},
		ErrorHandler: func(request *gin.Context, _ string, status int) {
			code := generated.INVALIDREQUEST
			if request.GetBool("board.authentication-failed") {
				status = http.StatusUnauthorized
				code = generated.UNAUTHORIZED
				request.Header("WWW-Authenticate", "Bearer")
			}
			if status == http.StatusNotFound {
				code = generated.NOTFOUND
			}
			request.AbortWithStatusJSON(status, generated.Error{Code: code, Message: "Request does not match the API contract"})
		},
	})
	return func(request *gin.Context) {
		if request.Request.ContentLength != 0 || len(request.Request.TransferEncoding) != 0 {
			mediaType, _, err := mime.ParseMediaType(request.GetHeader("Content-Type"))
			if err != nil || mediaType != "application/json" {
				request.AbortWithStatusJSON(http.StatusUnsupportedMediaType, generated.Error{Code: generated.INVALIDREQUEST, Message: "Expected application/json"})
				return
			}
			body, err := io.ReadAll(http.MaxBytesReader(request.Writer, request.Request.Body, 16*1024))
			if err != nil {
				status := http.StatusBadRequest
				var oversized *http.MaxBytesError
				if errors.As(err, &oversized) {
					status = http.StatusRequestEntityTooLarge
				}
				request.AbortWithStatusJSON(status, generated.Error{Code: generated.INVALIDREQUEST, Message: "Invalid request body"})
				return
			}
			if !json.Valid(body) {
				request.AbortWithStatusJSON(http.StatusBadRequest, generated.Error{Code: generated.INVALIDREQUEST, Message: "Expected one JSON value"})
				return
			}
			request.Request.Body = io.NopCloser(bytes.NewReader(body))
		}
		validator(request)
	}, nil
}

func New() (*gin.Engine, error) {
	validator, err := Validator(nil)
	if err != nil {
		return nil, err
	}
	router := gin.New()
	router.UseRawPath = true
	if err := router.SetTrustedProxies(nil); err != nil {
		return nil, err
	}
	router.Use(func(request *gin.Context) {
		request.Header("Cache-Control", "no-store")
		request.Next()
	})
	router.GET("/api/health", validator, func(request *gin.Context) {
		request.JSON(http.StatusOK, generated.Health{Status: generated.Ok, Mode: generated.InMemoryDemo})
	})
	router.NoRoute(func(request *gin.Context) {
		request.JSON(http.StatusNotFound, generated.Error{Code: generated.NOTFOUND, Message: "Endpoint is not implemented"})
	})
	return router, nil
}

func StrictHandler(handler generated.StrictServerInterface) generated.ServerInterface {
	internalError := func(request *gin.Context, _ error) {
		request.JSON(http.StatusInternalServerError, generated.Error{Code: generated.INTERNALERROR, Message: "Internal server error"})
	}
	return generated.NewStrictHandlerWithOptions(handler, nil, generated.StrictGinServerOptions{
		RequestErrorHandlerFunc: func(request *gin.Context, _ error) {
			request.JSON(http.StatusBadRequest, generated.Error{Code: generated.INVALIDREQUEST, Message: "Invalid request"})
		},
		HandlerErrorFunc: internalError, ResponseErrorHandlerFunc: internalError,
	})
}
